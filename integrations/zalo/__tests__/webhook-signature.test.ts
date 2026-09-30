import type { ContextQueue, HandleRequestProps } from "@chatbotx.io/sdk"
import { sha256Hex } from "@chatbotx.io/utils/crypto"
import { describe, expect, test, vi } from "vitest"
import { verifyZaloWebhook, webhookHandler } from "../src/handlers/webhook"
import { ZaloException } from "../src/lib/exception"
import type { ZaloConfig } from "../src/schema/definition"

const APP_ID = "app-1"
const KEY = "oa-secret"
const TS = "1790000000000"

const message = {
  app_id: APP_ID,
  event_name: "user_send_text",
  timestamp: TS,
  sender: { id: "user-1" },
  recipient: { id: "oa-1" },
  message: { msg_id: "m-1", text: "hello" },
}
const tagEvent = {
  app_id: APP_ID,
  event_name: "add_user_to_tag",
  timestamp: TS,
  oa_id: "oa-1",
  tag: { name: "vip", user_ids: ["user-1"] },
}

const macFor = (body: string, appId = APP_ID, ts = TS, key = KEY) =>
  sha256Hex(`${appId}${body}${ts}${key}`)

const call = (
  body: string,
  signature: string | null,
  oaSecretKey: string | undefined = KEY,
) => {
  const queueAdd = vi.fn()
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }
  if (signature !== null) {
    headers["X-ZEvent-Signature"] = signature
  }
  const props = {
    config: { clientId: APP_ID, oaSecretKey } as unknown as ZaloConfig,
    req: new Request("https://example.com/webhook", {
      method: "POST",
      body,
      headers,
    }),
    queue: { add: queueAdd as ContextQueue["add"] },
  } as unknown as HandleRequestProps<ZaloConfig>
  return { queueAdd, result: webhookHandler(props) }
}

const expect401 = async (result: Promise<unknown>) => {
  const error = await result.catch((e: unknown) => e)
  expect(error).toBeInstanceOf(ZaloException)
  expect((error as ZaloException).httpStatusCode).toBe(401)
}

describe("zalo webhook signature (s230a)", () => {
  test("a correctly signed event is routed", async () => {
    const body = JSON.stringify(message)
    const { queueAdd, result } = call(body, `mac=${await macFor(body)}`)
    await expect(result).resolves.toBe("ok")
    expect(queueAdd).toHaveBeenCalledWith(
      "incomingMessage",
      expect.objectContaining({ type: "incomingMessage" }),
    )
  })

  test("a bare hex mac (no mac= prefix) and upper-case hex are accepted", async () => {
    const body = JSON.stringify(message)
    const mac = await macFor(body)
    await expect(call(body, mac).result).resolves.toBe("ok")
    await expect(call(body, `mac=${mac.toUpperCase()}`).result).resolves.toBe(
      "ok",
    )
  })

  test("the mac covers the raw bytes: reformatted JSON with the same values is refused", async () => {
    const signed = JSON.stringify(message)
    const reformatted = JSON.stringify(message, null, 2)
    const { queueAdd, result } = call(
      reformatted,
      `mac=${await macFor(signed)}`,
    )
    await expect401(result)
    expect(queueAdd).not.toHaveBeenCalled()
  })

  test("no OA Secret Key configured refuses even a validly signed event (fail closed)", async () => {
    const body = JSON.stringify(message)
    for (const key of [undefined, "", " ", "\t\n"]) {
      const { queueAdd, result } = call(
        body,
        `mac=${await macFor(body, APP_ID, TS, key ?? "")}`,
        key,
      )
      await expect401(result)
      expect(queueAdd).not.toHaveBeenCalled()
    }
  })

  test("a missing, empty or malformed header is refused", async () => {
    const body = JSON.stringify(message)
    const mac = await macFor(body)
    for (const header of [
      null,
      "",
      "mac=",
      `sha256=${mac}`,
      `mac=${mac}0`,
      `mac=${mac.slice(1)}`,
      `mac=${mac}=extra`,
    ]) {
      await expect401(call(body, header).result)
    }
  })

  test("a wrong key, a tampered body or a swapped timestamp is refused", async () => {
    const body = JSON.stringify(message)
    await expect401(
      call(body, `mac=${await macFor(body, APP_ID, TS, "other")}`).result,
    )
    const tampered = JSON.stringify({
      ...message,
      message: { ...message.message, text: "evil" },
    })
    await expect401(call(tampered, `mac=${await macFor(body)}`).result)
    await expect401(call(body, `mac=${await macFor(body, APP_ID, "1")}`).result)
  })

  test("tag events are authenticated too", async () => {
    const body = JSON.stringify(tagEvent)
    const unsigned = call(body, null)
    await expect401(unsigned.result)
    expect(unsigned.queueAdd).not.toHaveBeenCalled()

    const signed = call(body, `mac=${await macFor(body)}`)
    await expect(signed.result).resolves.toBe("ok")
    expect(signed.queueAdd).toHaveBeenCalledWith(
      "channelLabelChange",
      expect.anything(),
    )
  })

  test("a signed event for another app is still refused by the app_id gate, tag events included", async () => {
    for (const event of [message, tagEvent]) {
      const body = JSON.stringify({ ...event, app_id: "app-2" })
      const { queueAdd, result } = call(
        body,
        `mac=${await macFor(body, "app-2")}`,
      )
      await expect(result).rejects.toThrow("Invalid app_id")
      expect(queueAdd).not.toHaveBeenCalled()
    }
  })

  test("non-JSON, null and field-less bodies are refused before routing", async () => {
    for (const body of [
      "not json",
      "null",
      "{}",
      '{"app_id":1}',
      `{"app_id":"${APP_ID}","timestamp":${TS}}`,
    ]) {
      await expect401(call(body, `mac=${await macFor(body)}`).result)
    }
  })

  test("fuzz: random signature headers never verify", async () => {
    const body = JSON.stringify(message)
    const alphabet = "0123456789abcdefABCDEF=mac ;,"
    let seed = 230
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed
    }
    for (let i = 0; i < 300; i++) {
      const length = next() % 80
      let header = ""
      for (let j = 0; j < length; j++) {
        header += alphabet[next() % alphabet.length]
      }
      await expect(verifyZaloWebhook(body, header, KEY)).rejects.toBeInstanceOf(
        ZaloException,
      )
    }
  })
})
