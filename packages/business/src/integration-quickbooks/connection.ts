import { and, db, eq } from "@chatbotx.io/database/client"
import type {
  QuickbooksCredential,
  QuickbooksEnvironment,
} from "@chatbotx.io/database/partials"
import { quickbooksEnvironments } from "@chatbotx.io/database/partials"
import { integrationQuickbooksModel } from "@chatbotx.io/database/schema"
import type { IntegrationQuickbooksModel } from "@chatbotx.io/database/types"
import { encryptedDataSchema, encryptUtils } from "@chatbotx.io/encryption"
import { distributedLock } from "@chatbotx.io/redis"
import { z } from "zod"
import { credentialMissingException } from "../errors"
import { logger } from "../logger"
import { platformCredentialService } from "../platform-credential/service"
import {
  QuickbooksApiError,
  QuickbooksReconnectRequiredError,
  type QuickbooksRequest,
  type QuickbooksTokenSet,
  quickbooksRequest,
  refreshQuickbooksTokens,
} from "./client"

export const quickbooksAuthSchema = z
  .object({
    accessToken: z.string().min(1),
    accessExpiresAt: z.number(),
    refreshToken: z.string().min(1),
    refreshExpiresAt: z.number(),
  })
  .strict()

/** AAD binds the ciphertext to its row: a blob copied to another row fails. */
export const quickbooksAuthAad = (integrationId: string) =>
  `quickbooks:${integrationId}`

export const encryptQuickbooksAuth = (
  tokens: QuickbooksTokenSet,
  integrationId: string,
) =>
  encryptUtils.encryptObject(
    quickbooksAuthSchema.parse(tokens),
    quickbooksAuthAad(integrationId),
  )

export const decryptQuickbooksAuth = (row: IntegrationQuickbooksModel) =>
  encryptUtils.decryptObject(
    encryptedDataSchema.parse(row.auth),
    quickbooksAuthSchema,
    quickbooksAuthAad(row.integrationId),
  )

/** What callers see of a connected company: never a token. */
export type QuickbooksConnection = {
  integrationId: string
  workspaceId: string
  realmId: string
  environment: QuickbooksEnvironment
  companyName: string | null
  homeCurrency: string
  multicurrency: boolean
  itemId: string
  mirrorEnabled: boolean
  mirrorFrom: Date | null
  tokenRefreshError: string | null
}

export const toQuickbooksConnection = (
  row: IntegrationQuickbooksModel,
): QuickbooksConnection => ({
  integrationId: row.integrationId,
  workspaceId: row.workspaceId,
  realmId: row.realmId,
  environment: quickbooksEnvironments.parse(row.environment),
  companyName: row.companyName,
  homeCurrency: row.homeCurrency,
  multicurrency: row.multicurrency,
  itemId: row.itemId,
  mirrorEnabled: row.mirrorEnabled,
  mirrorFrom: row.mirrorFrom,
  tokenRefreshError: row.tokenRefreshError,
})

/** The platform's Intuit app, or a credentialMissing error. */
export async function quickbooksAppCredential(): Promise<QuickbooksCredential> {
  const credential = await platformCredentialService.findDecryptedPlatform({
    type: "quickbooks",
  })
  if (!credential) {
    throw credentialMissingException(
      "The QuickBooks app is not configured (Admin > Platform credentials)",
    )
  }
  return credential.config
}

const REALM_ID = /^\d{1,32}$/

/** Refresh when the access token has less than this left. */
export const QUICKBOOKS_REFRESH_MARGIN_MS = 5 * 60 * 1000
/**
 * Must outlive the token call's 20 s timeout by a margin: two refreshes of
 * one rotating refresh token must never run at once.
 */
const REFRESH_LOCK_SECONDS = 60

const loadRow = async (integrationId: string) =>
  await db.query.integrationQuickbooksModel.findFirst({
    where: { integrationId },
  })

const SAVE_ATTEMPTS = 4

/**
 * Persist a rotated pair by CAS on the version read. Intuit already retired
 * the old refresh token, so a transient database error must not lose the new
 * one: the write is retried (bounded) before giving up loudly.
 */
async function saveRotatedTokens(
  row: IntegrationQuickbooksModel,
  tokens: QuickbooksTokenSet,
): Promise<IntegrationQuickbooksModel | undefined> {
  const auth = await encryptQuickbooksAuth(tokens, row.integrationId)
  for (let attempt = 1; ; attempt++) {
    try {
      const [saved] = await db
        .update(integrationQuickbooksModel)
        .set({
          auth,
          tokenVersion: row.tokenVersion + 1,
          tokenRefreshedAt: new Date(),
          tokenRefreshError: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(integrationQuickbooksModel.id, row.id),
            eq(integrationQuickbooksModel.tokenVersion, row.tokenVersion),
          ),
        )
        .returning()
      return saved
    } catch (error) {
      if (attempt >= SAVE_ATTEMPTS) {
        logger.error(
          { err: error, integrationId: row.integrationId },
          "quickbooks: rotated tokens could not be saved; the company will need a reconnect",
        )
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt))
    }
  }
}

/**
 * Refresh under the per-integration lock, deciding from the row read INSIDE
 * it: a concurrent caller that already refreshed (a newer `tokenVersion`)
 * is reused. The save is a CAS on the version read; `invalid_grant` marks
 * the connection for a reconnect instead of retrying.
 */
async function refreshLocked(props: {
  integrationId: string
  seenVersion: number
  force: boolean
}): Promise<{ row: IntegrationQuickbooksModel; accessToken: string }> {
  return await distributedLock.runExclusive({
    key: `qbo:refresh:${props.integrationId}`,
    timeoutInSeconds: REFRESH_LOCK_SECONDS,
    fn: async () => {
      const row = await loadRow(props.integrationId)
      if (!row) {
        throw credentialMissingException("QuickBooks is not connected")
      }
      if (row.tokenRefreshError) {
        throw new QuickbooksReconnectRequiredError(row.tokenRefreshError)
      }
      const auth = await decryptQuickbooksAuth(row)
      const fresh =
        auth.accessExpiresAt - Date.now() > QUICKBOOKS_REFRESH_MARGIN_MS
      if (fresh && (!props.force || row.tokenVersion !== props.seenVersion)) {
        return { row, accessToken: auth.accessToken }
      }
      const client = await quickbooksAppCredential()
      let tokens: QuickbooksTokenSet
      try {
        tokens = await refreshQuickbooksTokens({
          client,
          refreshToken: auth.refreshToken,
        })
      } catch (error) {
        if (error instanceof QuickbooksReconnectRequiredError) {
          // Another writer may have rotated the pair meanwhile (a reconnect,
          // or a refresher past a lost lock): its newer tokens win, no mark.
          const current = await loadRow(props.integrationId)
          if (current && current.tokenVersion !== row.tokenVersion) {
            return {
              row: current,
              accessToken: (await decryptQuickbooksAuth(current)).accessToken,
            }
          }
          await db
            .update(integrationQuickbooksModel)
            .set({ tokenRefreshError: error.message, updatedAt: new Date() })
            .where(
              and(
                eq(integrationQuickbooksModel.id, row.id),
                eq(integrationQuickbooksModel.tokenVersion, row.tokenVersion),
              ),
            )
        }
        throw error
      }
      const saved = await saveRotatedTokens(row, tokens)
      if (!saved) {
        // Only possible when the lock expired mid-call (or a reconnect wrote
        // new tokens meanwhile): the rotated pair is lost, the stored one wins.
        logger.error(
          { integrationId: row.integrationId },
          "quickbooks: refreshed tokens lost a version race; using the stored pair",
        )
        const current = await loadRow(props.integrationId)
        if (!current) {
          throw credentialMissingException("QuickBooks is not connected")
        }
        return {
          row: current,
          accessToken: (await decryptQuickbooksAuth(current)).accessToken,
        }
      }
      return { row: saved, accessToken: tokens.accessToken }
    },
  })
}

/**
 * Run `fn` with a live access token for the connection. Refreshes first when
 * the token is near expiry, and once more (forced) when QuickBooks refuses
 * it with a 401; a second 401 is the caller's error.
 */
export async function withQuickbooksToken<T>(
  integrationId: string,
  fn: (props: {
    accessToken: string
    connection: QuickbooksConnection
  }) => Promise<T>,
): Promise<T> {
  const row = await loadRow(integrationId)
  if (!row) {
    throw credentialMissingException("QuickBooks is not connected")
  }
  if (row.tokenRefreshError) {
    throw new QuickbooksReconnectRequiredError(row.tokenRefreshError)
  }
  const auth = await decryptQuickbooksAuth(row)
  let current =
    auth.accessExpiresAt - Date.now() > QUICKBOOKS_REFRESH_MARGIN_MS
      ? { row, accessToken: auth.accessToken }
      : await refreshLocked({
          integrationId,
          seenVersion: row.tokenVersion,
          force: false,
        })
  try {
    return await fn({
      accessToken: current.accessToken,
      connection: toQuickbooksConnection(current.row),
    })
  } catch (error) {
    if (!(error instanceof QuickbooksApiError && error.authRejected)) {
      throw error
    }
    current = await refreshLocked({
      integrationId,
      seenVersion: current.row.tokenVersion,
      force: true,
    })
    return await fn({
      accessToken: current.accessToken,
      connection: toQuickbooksConnection(current.row),
    })
  }
}

/** A QuickBooks API call on the connection, with token handling. */
export const quickbooksCall = (
  integrationId: string,
  request: Omit<QuickbooksRequest, "environment" | "realmId" | "accessToken">,
): Promise<Record<string, unknown>> =>
  withQuickbooksToken(integrationId, ({ accessToken, connection }) =>
    quickbooksRequest({
      ...request,
      environment: connection.environment,
      realmId: connection.realmId,
      accessToken,
    }),
  )

/**
 * Intuit's refresh token has a ROLLING 100-day expiry: a company nobody
 * invoiced for 100 days would need a reconnect. A weekly refresh keeps it.
 */
export const QUICKBOOKS_KEEPALIVE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Force a refresh of connections not refreshed for a week (the schedule's
 * body). One failure never stops the others; `invalid_grant` marks that
 * connection for a reconnect.
 */
export async function refreshIdleQuickbooksTokens(
  now = new Date(),
  limit = 200,
): Promise<{ refreshed: number; failed: number }> {
  const rows = await db.query.integrationQuickbooksModel.findMany({
    where: { tokenRefreshError: { isNull: true } },
    columns: {
      integrationId: true,
      tokenVersion: true,
      tokenRefreshedAt: true,
    },
    orderBy: { tokenRefreshedAt: "asc" },
    limit,
  })
  let refreshed = 0
  let failed = 0
  for (const row of rows) {
    if (
      now.getTime() - row.tokenRefreshedAt.getTime() <
      QUICKBOOKS_KEEPALIVE_MS
    ) {
      break
    }
    try {
      await refreshLocked({
        integrationId: row.integrationId,
        seenVersion: row.tokenVersion,
        force: true,
      })
      refreshed += 1
    } catch (error) {
      failed += 1
      logger.warn(
        { err: error, integrationId: row.integrationId },
        "quickbooks: keep-alive refresh failed",
      )
    }
  }
  return { refreshed, failed }
}

/** The connection of a workspace, or null. */
export async function quickbooksConnectionOf(
  workspaceId: string,
): Promise<QuickbooksConnection | null> {
  const row = await db.query.integrationQuickbooksModel.findFirst({
    where: { workspaceId },
  })
  return row ? toQuickbooksConnection(row) : null
}

/** The connection that holds `realmId`, or null. */
export async function quickbooksConnectionByRealm(
  realmId: string,
): Promise<QuickbooksConnection | null> {
  if (!REALM_ID.test(realmId)) {
    return null
  }
  const row = await db.query.integrationQuickbooksModel.findFirst({
    where: { realmId },
  })
  return row ? toQuickbooksConnection(row) : null
}
