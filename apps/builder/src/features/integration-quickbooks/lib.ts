import { env } from "@/env"

/** The one redirect URI registered with the platform's Intuit app. */
export const quickbooksRedirectUri = () =>
  new URL(
    "/integrations/quickbooks/callback",
    env.NEXT_PUBLIC_BUILDER_URL,
  ).toString()

/** Intuit's app-wide webhook: registered once in the Intuit developer portal. */
export const quickbooksWebhookUrl = () =>
  new URL(
    "/integrations/quickbooks/webhook",
    env.NEXT_PUBLIC_BUILDER_URL,
  ).toString()

export const quickbooksSettingsPath = (workspaceId: string) =>
  `/space/${workspaceId}/settings/integrations/quickbooks`
