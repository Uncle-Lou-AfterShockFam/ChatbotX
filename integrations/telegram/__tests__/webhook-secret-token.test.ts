import { describe, expect, test, vi } from "vitest"
import { TelegramException } from "../src/exception"
import { webhookHandler } from "../src/handlers/webhook"

const TOKEN = "a".repeat(64)
const UPDATE = JSON.stringify({
  update_id: 1,
  message: {
    message_id: 1,
    date: 1_700_000_000,
    chat: { id: 42, type: "private" },
    from: { id: 42, is_bot: false, first_name: "Test" },
    text: "hi",
  },
})

const call = (header: string | null, configured: unknown) => {
  const add = vi.fn()
  const headers: Record<string, string> = {}
  if (header !== null) {
    headers["X-Telegram-Bot-Api-Secret-Token"] = header
  }
  const result = webhookHandler({
    config: { botId: "bot-1", webhookSecretToken: configured },
    req: new Request("https://example.test/integrations/telegram/webhook", {
      method: "POST",
      body: UPDATE,
      headers,
    }),
    queue: { add },
  } as never)
  return { add, result }
}

// s231a: inbound updates were never authenticated; anyone knowing a botId
// could queue messages. The secret_token given to setWebhook is now required.
describe("telegram webhook secret token", () => {
  test("a matching token is accepted and queued", async () => {
    const { add, result } = call(TOKEN, TOKEN)

    await expect(result).resolves.toBe("ok")
    expect(add).toHaveBeenCalledOnce()
  })

  test.each([
    ["no header", null, TOKEN],
    ["an empty header", "", TOKEN],
    ["a wrong token", "b".repeat(64), TOKEN],
    ["a prefix of the token", TOKEN.slice(0, 63), TOKEN],
    ["the token plus a byte", `${TOKEN}a`, TOKEN],
    ["no token on record (fail closed)", TOKEN, undefined],
    ["a blank token on record (fail closed)", "", "   "],
    ["a non-string token on record (fail closed)", "12345", 12_345],
    ["an object token on record (fail closed)", "[object Object]", {}],
  ])("%s answers 401 and queues nothing", async (_label, header, configured) => {
    const { add, result } = call(header, configured)
    const error = await result.catch((e: unknown) => e)

    expect(error).toBeInstanceOf(TelegramException)
    expect((error as TelegramException).httpStatusCode).toBe(401)
    expect(add).not.toHaveBeenCalled()
  })
})
