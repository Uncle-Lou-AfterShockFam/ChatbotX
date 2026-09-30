import type { ContextQueue, HandleRequestProps } from "@chatbotx.io/sdk"
import { sha256Hex } from "@chatbotx.io/utils/crypto"
import { describe, expect, test, vi } from "vitest"
import { webhookHandler } from "../src/handlers/webhook"
import type { ZaloConfig } from "../src/schema/definition"

const APP_ID = "app-1"
const OA_SECRET_KEY = "oa-secret"

const config = {
  clientId: APP_ID,
  oaSecretKey: OA_SECRET_KEY,
} as unknown as ZaloConfig

// Signed as Zalo signs it (s230a): sha256(app_id + body + timestamp + key).
const buildProps = async (
  fields: Record<string, unknown>,
  queueAdd: ContextQueue["add"],
): Promise<HandleRequestProps<ZaloConfig>> => {
  const body = JSON.stringify({ timestamp: "1790000000000", ...fields })
  const mac = await sha256Hex(
    `${fields.app_id}${body}1790000000000${OA_SECRET_KEY}`,
  )
  return {
    config,
    req: new Request("https://example.com/webhook", {
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/json",
        "X-ZEvent-Signature": `mac=${mac}`,
      },
    }),
    queue: { add: queueAdd },
  } as unknown as HandleRequestProps<ZaloConfig>
}

describe("zalo webhookHandler event routing", () => {
  test("acks user_received_message delivery receipts without enqueueing", async () => {
    const queueAdd = vi.fn()

    const result = await webhookHandler(
      await buildProps(
        {
          app_id: APP_ID,
          event_name: "user_received_message",
          sender: { id: "oa-1" },
          recipient: { id: "user-1" },
          message: { msg_id: "m-1" },
        },
        queueAdd,
      ),
    )

    expect(result).toBe("ok")
    expect(queueAdd).not.toHaveBeenCalled()
  })

  test("routes user_send_text to the incomingMessage queue", async () => {
    const queueAdd = vi.fn()

    await webhookHandler(
      await buildProps(
        {
          app_id: APP_ID,
          event_name: "user_send_text",
          sender: { id: "user-1" },
          recipient: { id: "oa-1" },
          message: { msg_id: "m-2", text: "hello" },
        },
        queueAdd,
      ),
    )

    expect(queueAdd).toHaveBeenCalledWith(
      "incomingMessage",
      expect.objectContaining({
        type: "incomingMessage",
        data: expect.objectContaining({
          integrationType: "zalo",
          integrationIdentifier: "oa-1",
        }),
      }),
    )
  })

  test("routes oa_send_text echoes to the incomingMessage queue", async () => {
    const queueAdd = vi.fn()

    await webhookHandler(
      await buildProps(
        {
          app_id: APP_ID,
          event_name: "oa_send_text",
          sender: { id: "oa-1" },
          recipient: { id: "user-1" },
          message: { msg_id: "m-3", text: "reply" },
        },
        queueAdd,
      ),
    )

    expect(queueAdd).toHaveBeenCalledWith(
      "incomingMessage",
      expect.objectContaining({
        type: "incomingMessage",
        data: expect.objectContaining({
          integrationIdentifier: "oa-1",
        }),
      }),
    )
  })

  test("routes user_seen_message to the contactMarkAsRead queue", async () => {
    const queueAdd = vi.fn()

    await webhookHandler(
      await buildProps(
        {
          app_id: APP_ID,
          event_name: "user_seen_message",
          sender: { id: "user-1" },
          recipient: { id: "oa-1" },
          message: { msg_ids: ["m-4"] },
        },
        queueAdd,
      ),
    )

    expect(queueAdd).toHaveBeenCalledWith(
      "contactMarkAsRead",
      expect.objectContaining({
        type: "contactMarkAsRead",
        data: expect.objectContaining({
          integrationIdentifier: "oa-1",
          sourceConversationId: "user-1",
        }),
      }),
    )
  })
})
