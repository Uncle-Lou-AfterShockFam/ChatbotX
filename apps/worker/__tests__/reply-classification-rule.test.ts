// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from "vitest"

const classifyReply = vi.fn()
vi.mock("@chatbotx.io/business/reply-classification", () => ({
  replyClassificationService: {
    classifyReply: (...args: unknown[]) => classifyReply(...args),
  },
}))
vi.mock("../src/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

const { handleReplyClassificationRule } = await import(
  "../src/events/message/handlers/reply-classification-rule"
)

const payload = (over: Record<string, unknown> = {}) =>
  ({
    workspaceId: "1",
    contactId: "2",
    contactInboxId: "3",
    channel: "api",
    inboxId: "4",
    occurredAt: new Date().toISOString(),
    origin: "inbound",
    messageId: "m-1",
    autoReply: "ooo",
    ...over,
  }) as never

describe("reply-classification-rule (s228b)", () => {
  beforeEach(() => {
    classifyReply.mockReset().mockResolvedValue({ classification: null })
  })

  test("an inbound ooo / auto records the rule class once per message", async () => {
    await handleReplyClassificationRule([
      payload(),
      payload(), // the same message twice in a batch
      payload({ messageId: "m-2", autoReply: "auto" }),
    ])
    expect(
      classifyReply.mock.calls.map(([p]) => [p.class, p.messageId]),
    ).toEqual([
      ["ooo", "m-1"],
      ["auto", "m-2"],
    ])
    expect(classifyReply.mock.calls[0]?.[0]).toMatchObject({ source: "rule" })
  })

  test("a person's reply or an outbound message records nothing; a failure never throws", async () => {
    await handleReplyClassificationRule([
      payload({ autoReply: undefined }),
      payload({ origin: undefined }),
    ])
    expect(classifyReply).not.toHaveBeenCalled()
    classifyReply.mockRejectedValueOnce(new Error("db down"))
    await expect(
      handleReplyClassificationRule([payload(), payload({ messageId: "m-9" })]),
    ).resolves.toBeUndefined()
    expect(classifyReply).toHaveBeenCalledTimes(2)
  })
})
