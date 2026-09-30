import { SdkException } from "@chatbotx.io/sdk"

/**
 * Webhook callers are unauthenticated, so an exception's text (config state
 * such as "OA Secret Key not configured", zod issues) never reaches them
 * (s231a): the status survives (an SdkException's own, clamped to 400-599;
 * anything else is a 400), the body is a fixed message per status, and the
 * caller logs the detail.
 */
const publicWebhookMessage = (status: number) => {
  if (status === 401 || status === 403) {
    return "Unauthorized"
  }
  if (status === 404) {
    return "Not found"
  }
  return status < 500 ? "Invalid webhook request" : "Failed to process webhook"
}

export const publicWebhookErrorResponse = (error: unknown) => {
  let status = error instanceof SdkException ? error.httpStatusCode : 400
  if (!Number.isInteger(status) || status < 400 || status > 599) {
    status = 500
  }
  return new Response(
    JSON.stringify({ message: publicWebhookMessage(status) }),
    { status, headers: { "Content-Type": "application/json" } },
  )
}
