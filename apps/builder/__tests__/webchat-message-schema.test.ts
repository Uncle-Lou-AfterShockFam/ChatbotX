import { describe, expect, test } from "vitest"
import { createGuestConversationId } from "@/features/integration-webchat/lib/guest-conversation-id"
import { createWebchatMessageRequest } from "@/features/messages/schema/mutation"
import { listGuestMessagesRequest } from "@/features/messages/schema/query"

const WORKSPACE_ID = "11530439376896"
const WEBCHAT_ID = "11616773281153024"

const baseInput = (guestConversationId: string) => ({
  text: "hello",
  workspaceId: WORKSPACE_ID,
  webchatId: WEBCHAT_ID,
  guestConversationId,
})

describe("createWebchatMessageRequest — guestConversationId", () => {
  test("accepts the `<workspaceId>:<uuid>` id the server actually mints — a digits-only rule here leaves the widget's send button permanently disabled, since the form only enables it on formState.isValid", () => {
    const result = createWebchatMessageRequest.safeParse(
      baseInput(createGuestConversationId(WORKSPACE_ID)),
    )

    expect(result.success).toBe(true)
  })

  test("refuses a legacy digits-only Snowflake id: it is sequential, guessable, and the conversation's only credential (s213)", () => {
    const result = createWebchatMessageRequest.safeParse(
      baseInput("11616773281153025"),
    )

    expect(result.success).toBe(false)
  })

  test("refuses a minted id from another workspace (s213)", () => {
    const result = createWebchatMessageRequest.safeParse(
      baseInput(createGuestConversationId("99")),
    )

    expect(result.success).toBe(false)
  })

  test("rejects an arbitrary string — the id is the only proof a caller owns the guest session, so the format stays tight", () => {
    const result = createWebchatMessageRequest.safeParse(
      baseInput("../../not-an-id"),
    )

    expect(result.success).toBe(false)
  })

  test("rejects a non-uuid suffix", () => {
    const result = createWebchatMessageRequest.safeParse(
      baseInput(`${WORKSPACE_ID}:guest-1`),
    )

    expect(result.success).toBe(false)
  })
})

describe("listGuestMessagesRequest — guestConversationId", () => {
  test("accepts the minted id so history loads for a new visitor", () => {
    const result = listGuestMessagesRequest.safeParse({
      workspaceId: WORKSPACE_ID,
      webchatId: WEBCHAT_ID,
      guestConversationId: createGuestConversationId(WORKSPACE_ID),
    })

    expect(result.success).toBe(true)
  })

  test("refuses a legacy digits-only id and another workspace's id (s213)", () => {
    for (const guestConversationId of [
      "11616773281153025",
      createGuestConversationId("99"),
    ]) {
      const result = listGuestMessagesRequest.safeParse({
        workspaceId: WORKSPACE_ID,
        webchatId: WEBCHAT_ID,
        guestConversationId,
      })
      expect(result.success).toBe(false)
    }
  })
})
