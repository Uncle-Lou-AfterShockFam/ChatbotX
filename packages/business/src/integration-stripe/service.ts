import { and, db, eq, sql } from "@chatbotx.io/database/client"
import {
  integrationModel,
  integrationStripeModel,
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

export type StripeCredentials = {
  integrationId: string
  workspaceId: string
  livemode: boolean
  auth: StripeAuth
}

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
      livemode: row.livemode,
      auth,
    }
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
