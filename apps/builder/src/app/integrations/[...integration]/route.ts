import type { IntegrationType } from "@chatbotx.io/database/partials"
import { HandleRequestType } from "@chatbotx.io/sdk"
import { notFound } from "next/navigation"
import type { NextRequest } from "next/server"
import { toCamelCase } from "remeda"
import { handleCallback } from "./callback"
import { handleWebhook } from "./webhook"

const handleRequest = async (
  req: NextRequest,
  { params }: { params: Promise<{ integration: string[] }> },
) => {
  const allParams = await params
  const integrationType = toCamelCase(
    allParams.integration[0],
  ) as IntegrationType
  const integrationAction = allParams.integration[1]

  // Exactly /integrations/<type>/<action>: integrations dispatch on the LAST
  // path segment, so /<type>/webhook/callback would reach the callback
  // handler past the webhook route (s230a). Longer paths have their own
  // routes (whatsapp / stripe / woocommerce webhook/[integrationId]).
  if (
    allParams.integration.length !== 2 ||
    !(integrationType && integrationAction)
  ) {
    return notFound()
  }

  switch (integrationAction) {
    case HandleRequestType.callback:
      return await handleCallback(integrationType, req)
    case HandleRequestType.webhook:
      return await handleWebhook(integrationType, req)
    default:
      return notFound()
  }
}

export const GET = handleRequest
export const POST = handleRequest
