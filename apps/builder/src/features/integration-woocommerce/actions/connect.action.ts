"use server"

import { integrationWooCommerceService } from "@chatbotx.io/business/integration-woocommerce"
import { normalizeError } from "universal-error-normalizer"
import { env } from "@/env"
import { workspaceIdrequestParams } from "@/features/common/schema"
import { logger } from "@/lib/log"
import { settingsActionClient } from "@/lib/safe-action"
import { connectWooCommerceSchema } from "../schema"

/** Where the site posts `order.paid` (its wp-config HUBC_HUB_URL). */
const wooCommerceWebhookUrl = (integrationId: string) =>
  new URL(
    `/integrations/woocommerce/webhook/${integrationId}`,
    env.NEXT_PUBLIC_BUILDER_URL,
  ).toString()

/**
 * Link a site. The answer carries the wp-config lines ONCE: the hub never
 * shows the webhook secret again (reconnecting the same slug keeps it).
 */
export const connectWooCommerceAction = settingsActionClient
  .bindArgsSchemas(workspaceIdrequestParams)
  .inputSchema(connectWooCommerceSchema)
  .action(async ({ bindArgsParsedInputs: [workspaceId], parsedInput }) => {
    try {
      const result = await integrationWooCommerceService.connect({
        workspaceId,
        ...parsedInput,
        webhookUrlFor: wooCommerceWebhookUrl,
      })
      return {
        siteSlug: result.site.siteSlug,
        hubUrl: result.hubUrl,
        hubSecret: result.hubSecret,
      }
    } catch (error) {
      logger.error(
        { err: normalizeError(error), workspaceId },
        "Failed to connect a WooCommerce site",
      )
      throw error
    }
  })
