"use server"

import { integrationStripeService } from "@chatbotx.io/business/integration-stripe"
import { normalizeError } from "universal-error-normalizer"
import { env } from "@/env"
import { workspaceIdrequestParams } from "@/features/common/schema"
import { logger } from "@/lib/log"
import { workspaceActionClient } from "@/lib/safe-action"
import { connectStripeSchema } from "../schema"

/** The endpoint the hub registers on the workspace's Stripe account. */
const stripeWebhookUrl = (integrationId: string) =>
  new URL(
    `/integrations/stripe/webhook/${integrationId}`,
    env.NEXT_PUBLIC_BUILDER_URL,
  ).toString()

export const connectStripeAction = workspaceActionClient
  .bindArgsSchemas(workspaceIdrequestParams)
  .inputSchema(connectStripeSchema)
  .action(async ({ bindArgsParsedInputs: [workspaceId], parsedInput }) => {
    try {
      await integrationStripeService.connect({
        workspaceId,
        secretKey: parsedInput.apiKey,
        webhookUrlFor: stripeWebhookUrl,
      })
    } catch (error) {
      logger.error(
        { err: normalizeError(error), workspaceId },
        "Failed to connect Stripe",
      )
      throw error
    }
  })
