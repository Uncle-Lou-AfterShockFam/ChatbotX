import type { HandleRequestProps } from "@chatbotx.io/sdk"
import { timingSafeStringEqual } from "@chatbotx.io/utils/crypto"
import { TelegramException, TelegramWebhookException } from "../exception"
import type { TelegramConfig } from "../schema"
import { telegramUpdateSchema } from "../schema"

const SECRET_TOKEN_HEADER = "x-telegram-bot-api-secret-token"

export const webhookHandler = async (
  props: HandleRequestProps<TelegramConfig>,
): Promise<string> => {
  const { req, config, queue } = props

  // Telegram echoes the secret_token given to setWebhook in this header on
  // every update. Fail closed (s231a): a bot with no token on record, or a
  // request without the matching header, is refused before anything is read
  // or queued. A bot connected before s231a has no token: reconnect it.
  const configured: unknown = config.webhookSecretToken
  const expected = typeof configured === "string" ? configured.trim() : ""
  const received = req.headers.get(SECRET_TOKEN_HEADER) ?? ""
  if (!(expected && timingSafeStringEqual(received, expected))) {
    throw new TelegramException(
      "Unauthorized webhook: secret token mismatch",
      401,
      "unauthorized",
    )
  }

  const body = await req.text()
  if (!body) {
    throw new TelegramWebhookException("Empty webhook payload")
  }

  const update = telegramUpdateSchema.parse(JSON.parse(body))

  const integrationIdentifier = config.botId ?? ""

  if (update.callback_query) {
    const chatId = update.callback_query.message?.chat.id
    if (!chatId) {
      return "ok"
    }

    await queue?.add("incomingMessage", {
      type: "incomingMessage",
      data: {
        integrationType: "telegram",
        integrationIdentifier,
        payload: update,
      },
    })
    return "ok"
  }

  if (!update.message) {
    return "ok"
  }

  await queue?.add("incomingMessage", {
    type: "incomingMessage",
    data: {
      integrationType: "telegram",
      integrationIdentifier,
      payload: update,
    },
  })

  return "ok"
}
