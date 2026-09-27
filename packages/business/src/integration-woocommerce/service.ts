import { randomBytes } from "node:crypto"
import { and, db, eq, isNull, sql } from "@chatbotx.io/database/client"
import {
  normalizeInvoiceCurrency,
  WOOCOMMERCE_ACTION_TOKEN_PATTERN,
  WOOCOMMERCE_SITE_SLUG_PATTERN,
} from "@chatbotx.io/database/partials"
import {
  integrationModel,
  integrationWooCommerceModel,
  invoiceModel,
} from "@chatbotx.io/database/schema"
import type { IntegrationWooCommerceModel } from "@chatbotx.io/database/types"
import { encryptedDataSchema, encryptUtils } from "@chatbotx.io/encryption"
import { createId } from "@chatbotx.io/utils"
import { z } from "zod"
import { BaseService } from "../base.service"
import { credentialMissingException, validationException } from "../errors"
import {
  isPgBigintId,
  normalizeSiteUrl,
  postSiteAction,
  SiteUnreachableError,
  siteErrorCode,
  siteErrorMessage,
} from "./client"

export const WOOCOMMERCE_WEBHOOK_SECRET_PATTERN = /^whsec_[A-Za-z0-9+/]{43}=$/

export const wooCommerceAuthSchema = z
  .object({
    actionToken: z.string().regex(WOOCOMMERCE_ACTION_TOKEN_PATTERN),
    webhookSecret: z.string().regex(WOOCOMMERCE_WEBHOOK_SECRET_PATTERN),
  })
  .strict()
export type WooCommerceAuth = z.infer<typeof wooCommerceAuthSchema>

const idSchema = z.string().refine(isPgBigintId, "must be an id")

export const connectWooCommerceInputSchema = z
  .object({
    workspaceId: idSchema,
    siteSlug: z.string().trim().regex(WOOCOMMERCE_SITE_SLUG_PATTERN, {
      message: "Use the site's HUBC_SITE_SLUG (lowercase letters, digits, -)",
    }),
    siteUrl: z.string().trim().min(1).max(2048),
    actionToken: z.string().trim().regex(WOOCOMMERCE_ACTION_TOKEN_PATTERN, {
      message: "Paste a hub-connector action token (btc_...)",
    }),
    /** Builds the hub webhook URL the site posts to, for the integration id. */
    webhookUrlFor: z.function({ input: [z.string()], output: z.string() }),
  })
  .strict()
export type ConnectWooCommerceInput = z.input<
  typeof connectWooCommerceInputSchema
>

/** What the UI may see: never the token or the webhook secret. */
export type WooCommerceSiteSummary = Pick<
  IntegrationWooCommerceModel,
  | "id"
  | "integrationId"
  | "siteSlug"
  | "siteUrl"
  | "tokenLast4"
  | "currency"
  | "createdAt"
  | "updatedAt"
>

/**
 * What a connect returns ONCE for the site's wp-config: the hub URL and the
 * secret the site signs `order.paid` with (`HUBC_HUB_URL` / `HUBC_HUB_SECRET`).
 */
export type WooCommerceConnectResult = {
  site: WooCommerceSiteSummary
  hubUrl: string
  hubSecret: string
}

export type WooCommerceCredentials = {
  integrationId: string
  workspaceId: string
  siteSlug: string
  siteUrl: string
  currency: string
  auth: WooCommerceAuth
}

/** AAD binds the ciphertext to its row: a blob copied to another row fails. */
const authAad = (integrationId: string) => `woocommerce:${integrationId}`

const toSummary = (
  row: IntegrationWooCommerceModel,
): WooCommerceSiteSummary => ({
  id: row.id,
  integrationId: row.integrationId,
  siteSlug: row.siteSlug,
  siteUrl: row.siteUrl,
  tokenLast4: row.tokenLast4,
  currency: row.currency,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
})

/** A fresh Standard Webhooks secret, the format hub-connector's Signer takes. */
export const generateWooCommerceWebhookSecret = (): string =>
  `whsec_${randomBytes(32).toString("base64")}`

/**
 * The connect check: hub-connector >= 0.6.0 `store.info`, read-only (it
 * creates nothing on any plugin build), scope `orders:write` like
 * `order.invoice`; it answers the store currency the invoices must use.
 */
async function verifySite(siteUrl: string, token: string): Promise<string> {
  let answer: Awaited<ReturnType<typeof postSiteAction>>
  try {
    answer = await postSiteAction({
      siteUrl,
      token,
      action: "store.info",
      body: {},
    })
  } catch (error) {
    throw validationException(
      "siteUrl",
      error instanceof SiteUnreachableError
        ? error.message
        : "Could not reach the site",
    )
  }
  const code = siteErrorCode(answer)
  if (answer.status === 200 && answer.body?.ok === true) {
    const currency = normalizeInvoiceCurrency(answer.body.currency)
    if (!currency) {
      throw validationException(
        "siteUrl",
        `The store currency ${String(answer.body.currency)} is not supported`,
      )
    }
    return currency
  }
  if (answer.status === 401) {
    throw validationException("actionToken", "The site rejected this token")
  }
  if (answer.status === 403) {
    throw validationException(
      "actionToken",
      "This token lacks the orders:write scope (create one with `wp hub-connector token create --scopes=orders:write`)",
    )
  }
  if (answer.status === 404 && code === "unknown-action") {
    throw validationException(
      "siteUrl",
      "The site runs a hub-connector older than 0.6.0: update the plugin first",
    )
  }
  if (answer.status === 422 && code === "no-provider") {
    throw validationException(
      "siteUrl",
      "WooCommerce is not active on this site",
    )
  }
  if (answer.status === 404) {
    throw validationException(
      "siteUrl",
      "No hub-connector action endpoint at this URL (is the plugin active?)",
    )
  }
  throw validationException(
    "siteUrl",
    `Unexpected answer from the site: ${siteErrorMessage(answer)}`,
  )
}

/**
 * WooCommerce sites linked to a workspace (s211b): the `woocommerce` invoice
 * method. A connect verifies the site and token with `store.info` (and takes
 * the store currency from it), keeps the webhook secret of the same site at
 * the same URL (a token rotation must not break the site's wp-config), and
 * re-binds invoices a disconnect left behind.
 */
class IntegrationWooCommerceService extends BaseService {
  async listByWorkspaceId(
    workspaceId: string,
  ): Promise<WooCommerceSiteSummary[]> {
    const rows = await db.query.integrationWooCommerceModel.findMany({
      where: { workspaceId },
      orderBy: { siteSlug: "asc" },
    })
    return rows.map(toSummary)
  }

  /** Decrypted credentials by INTEGRATION id (the webhook path's key). */
  async credentialsByIntegrationId(
    integrationId: string,
  ): Promise<WooCommerceCredentials | null> {
    if (!idSchema.safeParse(integrationId).success) {
      return null
    }
    const row = await db.query.integrationWooCommerceModel.findFirst({
      where: { integrationId },
    })
    return row ? await this.decrypt(row) : null
  }

  /**
   * The site a new `woocommerce` invoice binds to: the named one (it must be
   * this workspace's), else the workspace's only site. Several sites and no
   * choice is refused, never guessed.
   */
  async credentialsForNewInvoice(
    workspaceId: string,
    integrationId: string | undefined,
  ): Promise<WooCommerceCredentials> {
    const rows = await db.query.integrationWooCommerceModel.findMany({
      where: integrationId ? { workspaceId, integrationId } : { workspaceId },
      limit: 2,
    })
    const [row] = rows
    if (!row) {
      throw credentialMissingException(
        integrationId
          ? "That WooCommerce site is not connected to this workspace"
          : "No WooCommerce site is connected",
      )
    }
    if (rows.length > 1) {
      throw validationException(
        "integrationId",
        "Several WooCommerce sites are connected: pick one",
      )
    }
    return await this.decrypt(row)
  }

  async connect(
    input: ConnectWooCommerceInput,
  ): Promise<WooCommerceConnectResult> {
    const props = connectWooCommerceInputSchema.parse(input)
    const siteUrl = normalizeSiteUrl(props.siteUrl)
    if (!siteUrl) {
      throw validationException(
        "siteUrl",
        "Use the site's https:// address with no path (https://example.org)",
      )
    }
    const currency = await verifySite(siteUrl, props.actionToken)

    const result = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`woocommerce-connect:${props.workspaceId}`}, 0))`,
      )
      const existing = await tx.query.integrationWooCommerceModel.findFirst({
        where: { workspaceId: props.workspaceId, siteSlug: props.siteSlug },
      })
      const integrationId = existing?.integrationId ?? createId()
      // The secret is kept only for the SAME site (a token rotation): a slug
      // re-pointed at another URL gets a new one, so the old install's
      // wp-config can no longer sign payments (s211b review).
      const webhookSecret =
        existing && existing.siteUrl === siteUrl
          ? (await this.decrypt(existing)).auth.webhookSecret
          : generateWooCommerceWebhookSecret()
      const auth = await encryptUtils.encryptObject(
        wooCommerceAuthSchema.parse({
          actionToken: props.actionToken,
          webhookSecret,
        }),
        authAad(integrationId),
      )
      const values = {
        siteUrl,
        auth,
        tokenLast4: props.actionToken.slice(-4),
        currency,
      }
      let row: IntegrationWooCommerceModel | undefined
      if (existing) {
        ;[row] = await tx
          .update(integrationWooCommerceModel)
          .set({ ...values, updatedAt: new Date() })
          .where(eq(integrationWooCommerceModel.id, existing.id))
          .returning()
      } else {
        await tx.insert(integrationModel).values({
          id: integrationId,
          workspaceId: props.workspaceId,
          integrationType: "woocommerce",
        })
        ;[row] = await tx
          .insert(integrationWooCommerceModel)
          .values({
            ...values,
            workspaceId: props.workspaceId,
            integrationId,
            siteSlug: props.siteSlug,
          })
          .returning()
      }
      if (!row) {
        throw new Error("woocommerce connect: write returned no row")
      }
      // Invoices a disconnect orphaned (integrationId SET NULL) on this SAME
      // site are re-adopted, so their payments resolve again.
      await tx
        .update(invoiceModel)
        .set({ integrationId, updatedAt: new Date() })
        .where(
          and(
            eq(invoiceModel.workspaceId, props.workspaceId),
            eq(invoiceModel.method, "woocommerce"),
            isNull(invoiceModel.integrationId),
            eq(invoiceModel.providerAccountId, siteUrl),
          ),
        )
      return { row, webhookSecret, updated: !!existing }
    })
    await this.audit(
      result.updated ? "update" : "connect",
      `${result.updated ? "updated" : "connected"} the WooCommerce site ${props.siteSlug} (${siteUrl})`,
    )
    return {
      site: toSummary(result.row),
      hubUrl: props.webhookUrlFor(result.row.integrationId),
      hubSecret: result.webhookSecret,
    }
  }

  async disconnect(props: {
    workspaceId: string
    integrationId: string
  }): Promise<void> {
    const existing = await db.query.integrationWooCommerceModel.findFirst({
      where: {
        workspaceId: props.workspaceId,
        integrationId: props.integrationId,
      },
    })
    if (!existing) {
      return
    }
    await db.transaction(async (tx) => {
      await tx
        .delete(integrationWooCommerceModel)
        .where(eq(integrationWooCommerceModel.id, existing.id))
      await tx
        .delete(integrationModel)
        .where(eq(integrationModel.id, existing.integrationId))
    })
    await this.audit(
      "disconnect",
      `disconnected the WooCommerce site ${existing.siteSlug}`,
    )
  }

  private async decrypt(
    row: IntegrationWooCommerceModel,
  ): Promise<WooCommerceCredentials> {
    const auth = await encryptUtils.decryptObject(
      encryptedDataSchema.parse(row.auth),
      wooCommerceAuthSchema,
      authAad(row.integrationId),
    )
    return {
      integrationId: row.integrationId,
      workspaceId: row.workspaceId,
      siteSlug: row.siteSlug,
      siteUrl: row.siteUrl,
      currency: row.currency,
      auth,
    }
  }
}

export const integrationWooCommerceService = new IntegrationWooCommerceService()
