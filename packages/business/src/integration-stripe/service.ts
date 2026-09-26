import { and, db, eq, isNull, lt, sql } from "@chatbotx.io/database/client"
import {
  type InvoiceMethod,
  invoiceMethods,
} from "@chatbotx.io/database/partials"
import {
  integrationModel,
  integrationStripeModel,
  invoiceModel,
  stripeCustomerModel,
} from "@chatbotx.io/database/schema"
import type { IntegrationStripeModel } from "@chatbotx.io/database/types"
import { encryptedDataSchema, encryptUtils } from "@chatbotx.io/encryption"
import { createId } from "@chatbotx.io/utils"
import { z } from "zod"
import { BaseService } from "../base.service"
import { credentialMissingException, validationException } from "../errors"
import { logger } from "../logger"
import {
  createStripeClient,
  STRIPE_SECRET_KEY_PATTERN,
  STRIPE_WEBHOOK_EVENTS,
  STRIPE_WEBHOOK_EVENTS_VERSION,
  STRIPE_WEBHOOK_SECRET_PATTERN,
  type Stripe,
} from "./client"

export const stripeAuthSchema = z
  .object({
    secretKey: z.string().regex(STRIPE_SECRET_KEY_PATTERN),
    webhookSecret: z.string().regex(STRIPE_WEBHOOK_SECRET_PATTERN),
  })
  .strict()
export type StripeAuth = z.infer<typeof stripeAuthSchema>

export const connectStripeInputSchema = z
  .object({
    workspaceId: z.string().min(1),
    secretKey: z.string().trim().regex(STRIPE_SECRET_KEY_PATTERN, {
      message: "Paste a Stripe secret key (sk_test_... or sk_live_...)",
    }),
    /** Builds the public webhook URL for the (possibly new) integration id. */
    webhookUrlFor: z.function({
      input: [z.string()],
      output: z.string(),
    }),
  })
  .strict()
export type ConnectStripeInput = z.input<typeof connectStripeInputSchema>

/** What the UI may see: never the key or the webhook secret. */
export type StripeConnectionSummary = Pick<
  IntegrationStripeModel,
  | "id"
  | "integrationId"
  | "accountId"
  | "accountName"
  | "livemode"
  | "keyLast4"
  | "webhookEndpointId"
  | "defaultMethod"
  | "createdAt"
  | "updatedAt"
>

/** AAD binds the ciphertext to its row: a blob copied to another row fails. */
const authAad = (integrationId: string) => `stripe:${integrationId}`

const toSummary = (row: IntegrationStripeModel): StripeConnectionSummary => ({
  id: row.id,
  integrationId: row.integrationId,
  accountId: row.accountId,
  accountName: row.accountName,
  livemode: row.livemode,
  keyLast4: row.keyLast4,
  webhookEndpointId: row.webhookEndpointId,
  defaultMethod: row.defaultMethod,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
})

const stripeErrorMessage = (error: unknown): string => {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message).slice(0, 300)
  }
  return "Stripe request failed"
}

const isStripeAuthError = (error: unknown): boolean =>
  !!error &&
  typeof error === "object" &&
  "type" in error &&
  ((error as { type: unknown }).type === "StripeAuthenticationError" ||
    (error as { type: unknown }).type === "StripePermissionError")

const isStripeMissingError = (error: unknown): boolean =>
  !!error &&
  typeof error === "object" &&
  "code" in error &&
  (error as { code: unknown }).code === "resource_missing"

export type StripeCredentials = {
  integrationId: string
  workspaceId: string
  accountId: string
  livemode: boolean
  defaultMethod: InvoiceMethod
  webhookEndpointId: string | null
  webhookEventsVersion: number
  auth: StripeAuth
}

export const setDefaultMethodInputSchema = z
  .object({
    workspaceId: z.string().regex(/^\d{1,20}$/),
    method: invoiceMethods,
  })
  .strict()

class IntegrationStripeService extends BaseService {
  async findByWorkspaceId(
    workspaceId: string,
  ): Promise<StripeConnectionSummary | null> {
    const row = await db.query.integrationStripeModel.findFirst({
      where: { workspaceId },
    })
    return row ? toSummary(row) : null
  }

  /** Decrypted credentials by INTEGRATION id (the webhook path's key). */
  async credentialsByIntegrationId(
    integrationId: string,
  ): Promise<StripeCredentials | null> {
    const row = await db.query.integrationStripeModel.findFirst({
      where: { integrationId },
    })
    return row ? this.decrypt(row) : null
  }

  async credentialsByWorkspaceId(
    workspaceId: string,
  ): Promise<StripeCredentials | null> {
    const row = await db.query.integrationStripeModel.findFirst({
      where: { workspaceId },
    })
    return row ? this.decrypt(row) : null
  }

  async credentialsByWorkspaceIdOrFail(
    workspaceId: string,
  ): Promise<StripeCredentials> {
    const credentials = await this.credentialsByWorkspaceId(workspaceId)
    if (!credentials) {
      throw credentialMissingException("Stripe is not connected")
    }
    return credentials
  }

  private async decrypt(
    row: IntegrationStripeModel,
  ): Promise<StripeCredentials> {
    const auth = await encryptUtils.decryptObject(
      encryptedDataSchema.parse(row.auth),
      stripeAuthSchema,
      authAad(row.integrationId),
    )
    return {
      integrationId: row.integrationId,
      workspaceId: row.workspaceId,
      accountId: row.accountId,
      livemode: row.livemode,
      defaultMethod: row.defaultMethod,
      webhookEndpointId: row.webhookEndpointId,
      webhookEventsVersion: row.webhookEventsVersion,
      auth,
    }
  }

  /** The method a create asking for `default` gets in this workspace. */
  async setDefaultMethod(
    input: z.input<typeof setDefaultMethodInputSchema>,
  ): Promise<StripeConnectionSummary> {
    const props = setDefaultMethodInputSchema.parse(input)
    const [row] = await db
      .update(integrationStripeModel)
      .set({ defaultMethod: props.method, updatedAt: new Date() })
      .where(eq(integrationStripeModel.workspaceId, props.workspaceId))
      .returning()
    if (!row) {
      throw credentialMissingException("Stripe is not connected")
    }
    await this.audit(
      "update",
      `set the default invoice method to ${props.method}`,
    )
    return toSummary(row)
  }

  /**
   * Subscribe an endpoint created under an older `STRIPE_WEBHOOK_EVENTS` to
   * the current list, in place (same URL, same secret). Called before a
   * method that needs the newer events is used, so a workspace connected
   * before them never takes a payment the hub would not hear about.
   */
  async ensureWebhookEvents(credentials: StripeCredentials): Promise<void> {
    if (credentials.webhookEventsVersion >= STRIPE_WEBHOOK_EVENTS_VERSION) {
      return
    }
    if (!credentials.webhookEndpointId) {
      throw validationException(
        "stripe",
        "The Stripe webhook endpoint is unknown: reconnect Stripe in Settings > Integrations",
      )
    }
    try {
      await createStripeClient(
        credentials.auth.secretKey,
      ).webhookEndpoints.update(credentials.webhookEndpointId, {
        enabled_events: [...STRIPE_WEBHOOK_EVENTS],
      })
    } catch (error) {
      if (isStripeAuthError(error) || isStripeMissingError(error)) {
        // Retrying cannot help: the key or the endpoint is gone.
        throw validationException(
          "stripe",
          `The Stripe webhook endpoint cannot be updated (${stripeErrorMessage(error)}): reconnect Stripe in Settings > Integrations`,
        )
      }
      throw error
    }
    await db
      .update(integrationStripeModel)
      .set({
        webhookEventsVersion: STRIPE_WEBHOOK_EVENTS_VERSION,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(integrationStripeModel.integrationId, credentials.integrationId),
          eq(
            integrationStripeModel.webhookEndpointId,
            credentials.webhookEndpointId,
          ),
          lt(
            integrationStripeModel.webhookEventsVersion,
            STRIPE_WEBHOOK_EVENTS_VERSION,
          ),
        ),
      )
  }

  /**
   * Verify the key against Stripe, register a
   * endpoint, and upsert the encrypted credentials. Serialised per workspace
   * with an advisory transaction lock, so two concurrent connects cannot
   * leave an orphan endpoint or a second row. An endpoint this call created
   * is deleted again when the write does not land.
   */
  async connect(input: ConnectStripeInput): Promise<StripeConnectionSummary> {
    const props = connectStripeInputSchema.parse(input)
    const stripe = createStripeClient(props.secretKey)
    let account: Stripe.Account
    try {
      account = await stripe.accounts.retrieveCurrent()
    } catch (error) {
      if (isStripeAuthError(error)) {
        throw validationException("secretKey", "Stripe rejected this key")
      }
      throw validationException(
        "secretKey",
        `Could not reach Stripe: ${stripeErrorMessage(error)}`,
      )
    }
    const livemode = props.secretKey.includes("_live_")
    const accountName =
      account.settings?.dashboard?.display_name ??
      account.business_profile?.name ??
      null

    let createdEndpointId: string | null = null
    try {
      const summary = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`stripe-connect:${props.workspaceId}`}, 0))`,
        )
        const existing = await tx.query.integrationStripeModel.findFirst({
          where: { workspaceId: props.workspaceId },
        })
        const integrationId = existing?.integrationId ?? createId()

        const endpoint = await stripe.webhookEndpoints.create({
          url: props.webhookUrlFor(integrationId),
          enabled_events: [...STRIPE_WEBHOOK_EVENTS],
          description: `ChatbotX hub workspace ${props.workspaceId}`,
          metadata: {
            hub_workspace_id: props.workspaceId,
            hub_integration_id: integrationId,
          },
        })
        createdEndpointId = endpoint.id
        const webhookSecret = endpoint.secret
        if (!webhookSecret) {
          throw validationException(
            "secretKey",
            "Stripe returned no webhook secret",
          )
        }
        const webhookEndpointId: string = endpoint.id

        const auth = await encryptUtils.encryptObject(
          stripeAuthSchema.parse({ secretKey: props.secretKey, webhookSecret }),
          authAad(integrationId),
        )
        const values = {
          auth,
          accountId: account.id,
          accountName,
          livemode,
          keyLast4: props.secretKey.slice(-4),
          webhookEndpointId,
          webhookEventsVersion: STRIPE_WEBHOOK_EVENTS_VERSION,
        }

        let row: IntegrationStripeModel | undefined
        if (existing) {
          ;[row] = await tx
            .update(integrationStripeModel)
            .set({ ...values, updatedAt: new Date() })
            .where(eq(integrationStripeModel.id, existing.id))
            .returning()
          if (existing.accountId !== account.id) {
            // Customer ids belong to the OLD account: drop the mapping.
            await tx
              .delete(stripeCustomerModel)
              .where(eq(stripeCustomerModel.integrationId, integrationId))
          }
        } else {
          await tx.insert(integrationModel).values({
            id: integrationId,
            workspaceId: props.workspaceId,
            integrationType: "stripe",
          })
          ;[row] = await tx
            .insert(integrationStripeModel)
            .values({
              ...values,
              workspaceId: props.workspaceId,
              integrationId,
            })
            .returning()
        }
        if (!row) {
          throw new Error("stripe connect: write returned no row")
        }
        // Invoices left by a disconnect (integrationId SET NULL) on this SAME
        // Stripe account are re-adopted, so their webhooks resolve again.
        await tx
          .update(invoiceModel)
          .set({ integrationId, updatedAt: new Date() })
          .where(
            and(
              eq(invoiceModel.workspaceId, props.workspaceId),
              isNull(invoiceModel.integrationId),
              eq(invoiceModel.providerAccountId, account.id),
            ),
          )
        return { summary: toSummary(row), previous: existing ?? null }
      })
      createdEndpointId = null
      if (
        summary.previous?.webhookEndpointId &&
        summary.previous.webhookEndpointId !== summary.summary.webhookEndpointId
      ) {
        await this.deleteEndpointQuietly(
          summary.previous,
          summary.previous.webhookEndpointId,
        )
      }
      await this.audit(
        summary.previous ? "update" : "connect",
        `${summary.previous ? "updated" : "connected"} the Stripe integration (${account.id}, ${livemode ? "live" : "test"})`,
      )
      return summary.summary
    } catch (error) {
      if (createdEndpointId) {
        await stripe.webhookEndpoints
          .del(createdEndpointId)
          .catch((cleanupError: unknown) =>
            logger.warn(
              { err: cleanupError, endpointId: createdEndpointId },
              "stripe connect: orphan webhook endpoint not deleted",
            ),
          )
      }
      throw error
    }
  }

  async disconnect(workspaceId: string): Promise<void> {
    const existing = await db.query.integrationStripeModel.findFirst({
      where: { workspaceId },
    })
    if (!existing) {
      return
    }
    if (existing.webhookEndpointId) {
      await this.deleteEndpointQuietly(existing, existing.webhookEndpointId)
    }
    await db.transaction(async (tx) => {
      await tx
        .delete(integrationStripeModel)
        .where(
          and(
            eq(integrationStripeModel.id, existing.id),
            eq(integrationStripeModel.workspaceId, workspaceId),
          ),
        )
      await tx
        .delete(integrationModel)
        .where(eq(integrationModel.id, existing.integrationId))
    })
    await this.audit("disconnect", "disconnected the Stripe integration")
  }

  private async deleteEndpointQuietly(
    row: IntegrationStripeModel,
    endpointId: string,
  ): Promise<void> {
    try {
      const { auth } = await this.decrypt(row)
      await createStripeClient(auth.secretKey).webhookEndpoints.del(endpointId)
    } catch (error) {
      logger.warn(
        { err: error, endpointId, workspaceId: row.workspaceId },
        "stripe: old webhook endpoint not deleted (remove it in the Stripe dashboard)",
      )
    }
  }
}

export const integrationStripeService = new IntegrationStripeService()
