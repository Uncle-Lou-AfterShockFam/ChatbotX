import { and, db, eq, inArray, isNull, sql } from "@chatbotx.io/database/client"
import type { QuickbooksCredential } from "@chatbotx.io/database/partials"
import {
  integrationModel,
  integrationQuickbooksModel,
  invoiceModel,
} from "@chatbotx.io/database/schema"
import { createId } from "@chatbotx.io/utils"
import { z } from "zod"
import { BaseService } from "../base.service"
import { ChatbotXException, validationException } from "../errors"
import { logger } from "../logger"
import {
  exchangeQuickbooksCode,
  type QuickbooksTokenSet,
  revokeQuickbooksToken,
} from "./client"
import {
  decryptQuickbooksAuth,
  encryptQuickbooksAuth,
  type QuickbooksConnection,
  quickbooksAppCredential,
  quickbooksConnectionOf,
} from "./connection"
import {
  ensureQuickbooksHubItem,
  quickbooksCallWithToken,
  readQuickbooksCompany,
} from "./entities"

const ID = /^[1-9]\d{0,18}$/

export const connectQuickbooksInputSchema = z
  .object({
    workspaceId: z.string().regex(ID),
    code: z.string().min(1).max(512),
    realmId: z.string().regex(/^\d{1,32}$/),
    redirectUri: z.url(),
  })
  .strict()
export type ConnectQuickbooksInput = z.infer<
  typeof connectQuickbooksInputSchema
>

/** What the settings page shows: never a token. */
export type QuickbooksSummary = Pick<
  QuickbooksConnection,
  | "integrationId"
  | "realmId"
  | "environment"
  | "companyName"
  | "homeCurrency"
  | "multicurrency"
  | "mirrorEnabled"
  | "mirrorFrom"
  | "tokenRefreshError"
>

/** Hub statuses in which a quickbooks invoice still needs its QBO company. */
const LIVE_STATUSES = ["draft", "open", "uncollectible"] as const

const connectConflict = (message: string) =>
  new ChatbotXException(message, "conflict", 409)

/**
 * A workspace's QuickBooks Online company (s214b). Connect runs after the
 * OAuth callback verified its signed state: it exchanges the code, reads the
 * company (currency, multicurrency, custom numbers) and the "Hub sales"
 * item, then writes the row under a per-workspace advisory lock.
 * A company serves one workspace; switching a workspace to another company
 * (or disconnecting) is refused while a quickbooks invoice is still live.
 */
class IntegrationQuickbooksService extends BaseService {
  async summary(workspaceId: string): Promise<QuickbooksSummary | null> {
    const connection = await quickbooksConnectionOf(workspaceId)
    if (!connection) {
      return null
    }
    const {
      integrationId,
      realmId,
      environment,
      companyName,
      homeCurrency,
      multicurrency,
      mirrorEnabled,
      mirrorFrom,
      tokenRefreshError,
    } = connection
    return {
      integrationId,
      realmId,
      environment,
      companyName,
      homeCurrency,
      multicurrency,
      mirrorEnabled,
      mirrorFrom,
      tokenRefreshError,
    }
  }

  async connect(input: ConnectQuickbooksInput): Promise<QuickbooksSummary> {
    const props = connectQuickbooksInputSchema.parse(input)
    // Refused before the code is spent: the grant would otherwise dangle in
    // the company's Connected Apps (the lock below re-checks it).
    await this.assertRealmFree(db, props)
    const app = await quickbooksAppCredential()
    const tokens = await exchangeQuickbooksCode({
      client: app,
      code: props.code,
      redirectUri: props.redirectUri,
    })
    let row: Awaited<ReturnType<typeof this.writeConnection>>
    try {
      row = await this.writeConnection(props, app, tokens)
    } catch (error) {
      // Nothing stored the new grant: revoke it (best effort).
      await revokeQuickbooksToken({ client: app, token: tokens.refreshToken })
      throw error
    }
    await this.audit(
      "connect",
      `connected QuickBooks company ${row.companyName ?? props.realmId}`,
    )
    const summary = await this.summary(props.workspaceId)
    if (!summary) {
      throw connectConflict("QuickBooks was disconnected while connecting")
    }
    return summary
  }

  /** The realm must not already serve another workspace. */
  private async assertRealmFree(
    tx: Pick<typeof db, "select">,
    props: { workspaceId: string; realmId: string },
  ): Promise<void> {
    const [elsewhere] = await tx
      .select({ workspaceId: integrationQuickbooksModel.workspaceId })
      .from(integrationQuickbooksModel)
      .where(eq(integrationQuickbooksModel.realmId, props.realmId))
      .limit(1)
    if (elsewhere && elsewhere.workspaceId !== props.workspaceId) {
      throw connectConflict(
        "This QuickBooks company is connected to another workspace",
      )
    }
  }

  private async writeConnection(
    props: ConnectQuickbooksInput,
    app: QuickbooksCredential,
    tokens: QuickbooksTokenSet,
  ) {
    const call = quickbooksCallWithToken({
      environment: app.environment,
      realmId: props.realmId,
      accessToken: tokens.accessToken,
    })
    const company = await readQuickbooksCompany(call, props.realmId)
    const itemId = await ensureQuickbooksHubItem(call)
    const replaced: { refreshToken: string | null } = { refreshToken: null }
    const row = await db.transaction(async (tx) => {
      // Per workspace AND per realm: two workspaces racing for one company
      // meet here, not at the unique index.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`quickbooks-connect:${props.workspaceId}`}, 0))`,
      )
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`quickbooks-realm:${props.realmId}`}, 0))`,
      )
      await this.assertRealmFree(tx, props)
      const existing = await tx.query.integrationQuickbooksModel.findFirst({
        where: { workspaceId: props.workspaceId },
      })
      const now = new Date()
      const fields = {
        environment: app.environment,
        companyName: company.companyName,
        homeCurrency: company.homeCurrency,
        multicurrency: company.multicurrency,
        itemId,
        tokenRefreshedAt: now,
        tokenRefreshError: null,
        updatedAt: now,
      }
      if (existing && existing.realmId === props.realmId) {
        const [updated] = await tx
          .update(integrationQuickbooksModel)
          .set({
            ...fields,
            auth: await encryptQuickbooksAuth(tokens, existing.integrationId),
            // Monotonic under READ COMMITTED: a refresh that read the old
            // version can never CAS over the new grant.
            tokenVersion: sql`${integrationQuickbooksModel.tokenVersion} + 1`,
          })
          .where(eq(integrationQuickbooksModel.id, existing.id))
          .returning()
        return updated
      }
      if (existing) {
        await this.assertNoLiveInvoices(tx, existing.integrationId)
        replaced.refreshToken = (
          await decryptQuickbooksAuth(existing)
        ).refreshToken
        await tx
          .delete(integrationModel)
          .where(eq(integrationModel.id, existing.integrationId))
      }
      const integrationId = createId()
      await tx.insert(integrationModel).values({
        id: integrationId,
        workspaceId: props.workspaceId,
        integrationType: "quickbooks",
      })
      const [inserted] = await tx
        .insert(integrationQuickbooksModel)
        .values({
          ...fields,
          workspaceId: props.workspaceId,
          integrationId,
          realmId: props.realmId,
          auth: await encryptQuickbooksAuth(tokens, integrationId),
          changesSince: now,
        })
        .returning()
      // quickbooks invoices a disconnect left behind in this SAME company.
      await tx
        .update(invoiceModel)
        .set({ integrationId, updatedAt: now })
        .where(
          and(
            eq(invoiceModel.workspaceId, props.workspaceId),
            eq(invoiceModel.method, "quickbooks"),
            isNull(invoiceModel.integrationId),
            eq(invoiceModel.providerAccountId, props.realmId),
          ),
        )
      return inserted
    })
    if (!row) {
      throw new Error("quickbooks connect: write returned no row")
    }
    if (replaced.refreshToken) {
      // The workspace moved to another company: end the old grant.
      await revokeQuickbooksToken({ client: app, token: replaced.refreshToken })
    }
    return row
  }

  /**
   * Turn the bookkeeping mirror on or off. The first enable fixes
   * `mirrorFrom`: invoices created before it are never copied (no backfill).
   */
  async setMirror(props: {
    workspaceId: string
    enabled: boolean
  }): Promise<QuickbooksSummary> {
    if (!ID.test(props.workspaceId) || typeof props.enabled !== "boolean") {
      throw validationException("mirror", "Invalid mirror setting")
    }
    const [updated] = await db
      .update(integrationQuickbooksModel)
      .set({
        mirrorEnabled: props.enabled,
        mirrorFrom: props.enabled
          ? sql`coalesce(${integrationQuickbooksModel.mirrorFrom}, now())`
          : integrationQuickbooksModel.mirrorFrom,
        updatedAt: new Date(),
      })
      .where(eq(integrationQuickbooksModel.workspaceId, props.workspaceId))
      .returning()
    if (!updated) {
      throw validationException("quickbooks", "QuickBooks is not connected")
    }
    await this.audit(
      "update",
      `${props.enabled ? "enabled" : "disabled"} the QuickBooks invoice mirror`,
    )
    return (await this.summary(props.workspaceId)) as QuickbooksSummary
  }

  async disconnect(workspaceId: string): Promise<void> {
    const removed = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`quickbooks-connect:${workspaceId}`}, 0))`,
      )
      // The invoice-create lock too: a quickbooks invoice created meanwhile
      // is either seen as live here, or its insert fails on the gone row.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`invoice:${workspaceId}`}, 0))`,
      )
      const existing = await tx.query.integrationQuickbooksModel.findFirst({
        where: { workspaceId },
      })
      if (!existing) {
        return null
      }
      await this.assertNoLiveInvoices(tx, existing.integrationId)
      await tx
        .delete(integrationModel)
        .where(eq(integrationModel.id, existing.integrationId))
      return existing
    })
    if (!removed) {
      return
    }
    try {
      // Revoking the refresh token ends the whole grant (access token too).
      const { refreshToken } = await decryptQuickbooksAuth(removed)
      await revokeQuickbooksToken({
        client: await quickbooksAppCredential(),
        token: refreshToken,
      })
    } catch (error) {
      logger.warn(
        { err: error, integrationId: removed.integrationId },
        "quickbooks: token not revoked on disconnect",
      )
    }
    await this.audit(
      "disconnect",
      `disconnected QuickBooks company ${removed.companyName ?? removed.realmId}`,
    )
  }

  private async assertNoLiveInvoices(
    tx: Pick<typeof db, "select">,
    integrationId: string,
  ): Promise<void> {
    const [live] = await tx
      .select({ number: invoiceModel.number })
      .from(invoiceModel)
      .where(
        and(
          eq(invoiceModel.integrationId, integrationId),
          eq(invoiceModel.method, "quickbooks"),
          inArray(invoiceModel.status, [...LIVE_STATUSES]),
        ),
      )
      .limit(1)
    if (live) {
      throw connectConflict(
        `Invoice #${live.number} is still collected through this QuickBooks company: void it or let it be paid first`,
      )
    }
  }
}

export const integrationQuickbooksService = new IntegrationQuickbooksService()
