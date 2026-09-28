import { and, db, eq, inArray, isNull, sql } from "@chatbotx.io/database/client"
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
import { exchangeQuickbooksCode, revokeQuickbooksToken } from "./client"
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
    const app = await quickbooksAppCredential()
    const tokens = await exchangeQuickbooksCode({
      client: app,
      code: props.code,
      redirectUri: props.redirectUri,
    })
    const call = quickbooksCallWithToken({
      environment: app.environment,
      realmId: props.realmId,
      accessToken: tokens.accessToken,
    })
    const company = await readQuickbooksCompany(call, props.realmId)
    const itemId = await ensureQuickbooksHubItem(call)

    const row = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`quickbooks-connect:${props.workspaceId}`}, 0))`,
      )
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
            tokenVersion: existing.tokenVersion + 1,
          })
          .where(eq(integrationQuickbooksModel.id, existing.id))
          .returning()
        return updated
      }
      if (existing) {
        await this.assertNoLiveInvoices(tx, existing.integrationId)
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
    await this.audit(
      "connect",
      `connected QuickBooks company ${company.companyName ?? props.realmId}`,
    )
    return (await this.summary(props.workspaceId)) as QuickbooksSummary
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
    const existing = await db.query.integrationQuickbooksModel.findFirst({
      where: { workspaceId },
    })
    if (!existing) {
      return
    }
    await this.assertNoLiveInvoices(db, existing.integrationId)
    try {
      // Revoking the refresh token ends the whole grant (access token too).
      const { refreshToken } = await decryptQuickbooksAuth(existing)
      await revokeQuickbooksToken({
        client: await quickbooksAppCredential(),
        token: refreshToken,
      })
    } catch (error) {
      logger.warn(
        { err: error, integrationId: existing.integrationId },
        "quickbooks: token not revoked on disconnect",
      )
    }
    await db
      .delete(integrationModel)
      .where(eq(integrationModel.id, existing.integrationId))
    await this.audit(
      "disconnect",
      `disconnected QuickBooks company ${existing.companyName ?? existing.realmId}`,
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
