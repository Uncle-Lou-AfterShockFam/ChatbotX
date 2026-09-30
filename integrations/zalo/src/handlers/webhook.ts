import {
  type ContextQueue,
  type HandleRequestProps,
  SdkException,
} from "@chatbotx.io/sdk"
import { ZaloException } from "../lib/exception"
import { logger } from "../lib/logger"
import { sha256Hex, timingSafeStringEqual } from "../lib/webhook"
import type { ZaloConfig } from "../schema/definition"
import { TAG_EVENT_NAMES, zaloWebhookEventSchema } from "../schema/webhook"

const TAG_EVENT_NAME_SET = new Set<string>(TAG_EVENT_NAMES)

const SIGNATURE_HEADER = "X-ZEvent-Signature"
const MAC_PATTERN = /^(?:mac=)?([0-9a-fA-F]{64})$/

const unauthorized = (reason: string) =>
  new ZaloException(`Unauthorized webhook: ${reason}`, 401, "unauthorized")

/**
 * Zalo signs every OA webhook: X-ZEvent-Signature = "mac=" +
 * sha256(app_id + raw body + timestamp + OA Secret Key), a plain SHA-256 of
 * the concatenation (not an HMAC), over the body bytes as sent. app_id and
 * timestamp come from the body itself. Fails closed: no OA Secret Key
 * configured refuses every event, tag events included. Returns the parsed
 * JSON only once the signature holds.
 */
export async function verifyZaloWebhook(
  rawBody: string,
  signatureHeader: string | null,
  oaSecretKey: string | undefined,
): Promise<unknown> {
  if (!oaSecretKey) {
    logger.error(
      "zalo webhook refused: no OA Secret Key in the Zalo platform credential",
    )
    throw unauthorized("OA Secret Key not configured")
  }
  const mac = MAC_PATTERN.exec(signatureHeader?.trim() ?? "")?.[1]
  if (!mac) {
    throw unauthorized(`missing or malformed ${SIGNATURE_HEADER}`)
  }
  let body: unknown
  try {
    body = JSON.parse(rawBody)
  } catch {
    throw unauthorized("body is not JSON")
  }
  const { app_id: appId, timestamp } = (body ?? {}) as Record<string, unknown>
  if (
    typeof appId !== "string" ||
    !(typeof timestamp === "string" || typeof timestamp === "number")
  ) {
    throw unauthorized("app_id or timestamp missing")
  }
  const expected = await sha256Hex(
    `${appId}${rawBody}${timestamp}${oaSecretKey}`,
  )
  if (!timingSafeStringEqual(mac.toLowerCase(), expected)) {
    throw unauthorized("signature mismatch")
  }
  return body
}

const handleWebhookEvent = async (
  req: Request,
  config: ZaloConfig,
  queue: ContextQueue,
): Promise<void> => {
  // Before any routing, tag events included; its 401 is not re-wrapped.
  const body = await verifyZaloWebhook(
    await req.text(),
    req.headers.get(SIGNATURE_HEADER),
    config.oaSecretKey,
  )
  try {
    const webhookData = zaloWebhookEventSchema.parse(body)

    // Tag events carry oa_id + tag (no sender/recipient). Route them before
    // the message-event handling below.
    if (TAG_EVENT_NAME_SET.has(webhookData.event_name) && webhookData.oa_id) {
      await queue.add("channelLabelChange", {
        type: "channelLabelChange",
        data: {
          integrationType: "zalo",
          integrationIdentifier: webhookData.oa_id,
          payload: webhookData,
        },
      })
      return
    }

    if (webhookData.app_id !== config.clientId) {
      throw new SdkException("Invalid app_id in webhook payload")
    }

    // Message events always carry sender/recipient.
    if (!(webhookData.sender && webhookData.recipient)) {
      throw new SdkException("Missing sender/recipient in message event")
    }

    // Delivery receipts carry only the delivered msg_id — no text or
    // attachments — so routing them to incomingMessage makes the handler
    // throw "No content found" and the job retry forever. There is no
    // delivered-status pipeline yet; ack and drop.
    if (webhookData.event_name === "user_received_message") {
      return
    }

    if (webhookData.event_name === "user_seen_message") {
      await queue.add("contactMarkAsRead", {
        type: "contactMarkAsRead",
        data: {
          integrationType: "zalo",
          integrationIdentifier: webhookData.recipient.id,
          sourceConversationId: webhookData.sender.id,
          payload: webhookData,
        },
      })
    } else {
      const integrationIdentifier = webhookData.event_name.includes("user_send")
        ? webhookData.recipient.id
        : webhookData.sender.id

      await queue.add("incomingMessage", {
        type: "incomingMessage",
        data: {
          integrationType: "zalo",
          integrationIdentifier,
          payload: webhookData,
        },
      })
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error
        ? error.message
        : "Unknown error processing webhook"

    throw new SdkException(`Failed to process webhook event: ${errorMessage}`)
  }
}

export const webhookHandler = async ({
  config,
  req,
  queue,
}: HandleRequestProps<ZaloConfig>): Promise<string> => {
  try {
    if (req.method === "POST") {
      await handleWebhookEvent(req, config, queue as ContextQueue)

      return "ok"
    }

    throw new SdkException(`Unsupported HTTP method: ${req.method}`)
  } catch (error) {
    if (error instanceof ZaloException && error.httpStatusCode === 401) {
      throw error
    }
    const errorMessage =
      error instanceof Error ? error.message : "Unknown webhook error"

    throw new SdkException(`Webhook processing failed: ${errorMessage}`)
  }
}
