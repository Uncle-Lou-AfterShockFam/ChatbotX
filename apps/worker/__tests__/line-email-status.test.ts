// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from "vitest"

const markDelivered = vi.fn()
const markFailed = vi.fn()
vi.mock("@chatbotx.io/analytics", () => ({
  emailTopicAnalyticsService: { markDelivered, markFailed },
}))
const newsletterRef = vi.fn()
vi.mock("@chatbotx.io/business", () => ({
  apiChannelOutboxService: {
    newsletterRef: (...args: unknown[]) => newsletterRef(...args),
  },
}))

const addSuppression = vi.fn()
vi.mock("@chatbotx.io/business/email-suppression", () => ({
  emailSuppressionService: {
    add: (...args: unknown[]) => addSuppression(...args),
  },
}))
const endOutreach = vi.fn()
vi.mock("@chatbotx.io/business/contact-sequence", () => ({
  contactSequenceService: {
    endOutreach: (...args: unknown[]) => endOutreach(...args),
  },
}))
const classifyReply = vi.fn()
vi.mock("@chatbotx.io/business/reply-classification", () => ({
  replyClassificationService: {
    classifyReply: (...args: unknown[]) => classifyReply(...args),
  },
}))
vi.mock("../src/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

const { lineEmailRef, settleLineEmailStatus } = await import(
  "../src/integration/handlers/line-email-status"
)

describe("lineEmailRef (s222b)", () => {
  test("a tracked send carries its token; an untracked one its fallback id", () => {
    expect(lineEmailRef("tok-1", "uuid-1")).toBe("email:t:tok-1")
    expect(lineEmailRef(undefined, "uuid-1")).toBe("email:u:uuid-1")
  })
})

describe("settleLineEmailStatus (s222b): a pull line's final word settles the queued newsletter", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    newsletterRef.mockResolvedValue("email:t:tok-1")
  })

  test("delivered and failed settle the recipient named by the outbox row's ref, scoped to the status's inbox", async () => {
    await expect(
      settleLineEmailStatus({
        workspaceId: "ws-1",
        inboxId: "in-1",
        messageId: "outbox:ob_7",
        status: "delivered",
      }),
    ).resolves.toBe(true)
    expect(newsletterRef).toHaveBeenCalledWith({ inboxId: "in-1", id: "ob_7" })
    expect(markDelivered).toHaveBeenCalledWith("tok-1")
    await settleLineEmailStatus({
      workspaceId: "ws-1",
      inboxId: "in-1",
      messageId: "outbox:ob_8",
      status: "failed",
    })
    expect(markFailed).toHaveBeenCalledWith("tok-1")
  })

  test("read, a non-outbox id, a non-newsletter row or an untracked send settle nothing", async () => {
    const cases: [string, string][] = [
      ["outbox:ob_1", "read"],
      ["msg:5", "failed"],
      ["hook:9", "delivered"],
    ]
    for (const [messageId, status] of cases) {
      await expect(
        settleLineEmailStatus({
          workspaceId: "ws-1",
          inboxId: "in-1",
          messageId,
          status,
        }),
      ).resolves.toBe(false)
    }
    expect(newsletterRef).not.toHaveBeenCalled()
    newsletterRef.mockResolvedValueOnce(null)
    newsletterRef.mockResolvedValueOnce(
      "email:u:1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed",
    )
    for (let i = 0; i < 2; i++) {
      await expect(
        settleLineEmailStatus({
          inboxId: "in-1",
          messageId: "outbox:ob_1",
          status: "failed",
        }),
      ).resolves.toBe(false)
    }
    expect(markFailed).not.toHaveBeenCalled()
    expect(markDelivered).not.toHaveBeenCalled()
  })
})

describe("settleLineEmailStatus (s224b): an unreachable email send suppresses its address", () => {
  const base = {
    workspaceId: "ws-1",
    inboxId: "in-1",
    messageId: "outbox:ob_9",
    status: "failed",
    recipient: "Bounce@Example.com",
  }
  beforeEach(() => {
    vi.clearAllMocks()
    newsletterRef.mockResolvedValue("email:t:tok-1")
  })

  test("every unreachable reason adds the lower-cased address with the ref as source, and still settles the row", async () => {
    for (const error of [
      "bad-address",
      "undelivered",
      "bounce",
      "hard-bounce",
      "complaint",
    ]) {
      addSuppression.mockClear()
      await expect(settleLineEmailStatus({ ...base, error })).resolves.toBe(
        true,
      )
      expect(addSuppression).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        value: "bounce@example.com",
        reason: "unreachable",
        source: "email:t:tok-1",
      })
    }
    expect(markFailed).toHaveBeenCalledWith("tok-1")
  })

  test("an untracked email ref suppresses too (nothing to settle)", async () => {
    newsletterRef.mockResolvedValue("email:u:uuid-1")
    await expect(
      settleLineEmailStatus({ ...base, error: "hard-bounce" }),
    ).resolves.toBe(false)
    expect(addSuppression).toHaveBeenCalledOnce()
    expect(markFailed).not.toHaveBeenCalled()
  })

  test("skip, line-error, unknown, empty and non-string reasons, and delivered, add nothing", async () => {
    for (const error of [
      "suppressed",
      "opted-out",
      "line-error",
      "mystery",
      "",
      null,
      undefined,
      42,
      { reason: "bounce" },
    ]) {
      await settleLineEmailStatus({ ...base, error })
    }
    await settleLineEmailStatus({
      ...base,
      status: "delivered",
      error: "bounce",
    })
    expect(addSuppression).not.toHaveBeenCalled()
  })

  test("a non-email outbox row (an SMS line's bad number) never suppresses", async () => {
    newsletterRef.mockResolvedValue(null)
    await settleLineEmailStatus({ ...base, error: "bad-number" })
    newsletterRef.mockResolvedValue("sms:whatever")
    await settleLineEmailStatus({ ...base, error: "bounce" })
    expect(addSuppression).not.toHaveBeenCalled()
  })

  test("a recipient that is not ONE address (missing, a domain, junk) is not added", async () => {
    for (const recipient of [
      undefined,
      null,
      "",
      "@example.com",
      "a@b@c.com",
      "x y@z.com",
      7,
    ]) {
      await settleLineEmailStatus({ ...base, error: "bounce", recipient })
    }
    expect(addSuppression).not.toHaveBeenCalled()
  })

  test("a failed suppression write propagates (the status job retries), and the row is left for the retry", async () => {
    addSuppression.mockRejectedValueOnce(new Error("db down"))
    await expect(
      settleLineEmailStatus({ ...base, error: "bounce" }),
    ).rejects.toThrow("db down")
    expect(markFailed).not.toHaveBeenCalled()
  })
})

describe("settleLineEmailStatus (s228b): an unreachable verdict ends the contact's outreach", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    newsletterRef.mockResolvedValue("email:u:uuid-1")
    endOutreach.mockResolvedValue(["seq-1"])
    classifyReply.mockResolvedValue({ classification: null, dealId: null })
  })

  test("a bounce on an email ref with a contact ends it as bounced; no contact, or a delivered status, ends nothing", async () => {
    await settleLineEmailStatus({
      workspaceId: "ws-1",
      inboxId: "in-1",
      messageId: "outbox:ob_1",
      status: "failed",
      error: "hard-bounce",
      recipient: "gone@example.com",
      contactId: "c-1",
    })
    expect(endOutreach).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      contactId: "c-1",
      reason: "bounced",
    })
    // s228b PR 3: the bounce is also the contact's reply classification.
    expect(classifyReply).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      contactId: "c-1",
      class: "bounce",
      source: "rule",
      reason: "hard-bounce",
    })
    endOutreach.mockClear()
    await settleLineEmailStatus({
      workspaceId: "ws-1",
      inboxId: "in-1",
      messageId: "outbox:ob_2",
      status: "failed",
      error: "hard-bounce",
      recipient: "gone@example.com",
    })
    await settleLineEmailStatus({
      workspaceId: "ws-1",
      inboxId: "in-1",
      messageId: "outbox:ob_3",
      status: "delivered",
      recipient: "gone@example.com",
      contactId: "c-1",
    })
    expect(endOutreach).not.toHaveBeenCalled()
  })

  test("ending the enrolments failing never fails the status (the suppression already stops sends)", async () => {
    endOutreach.mockRejectedValueOnce(new Error("db down"))
    await expect(
      settleLineEmailStatus({
        workspaceId: "ws-1",
        inboxId: "in-1",
        messageId: "outbox:ob_4",
        status: "failed",
        error: "hard-bounce",
        recipient: "gone@example.com",
        contactId: "c-1",
      }),
    ).resolves.toBe(false)
    expect(addSuppression).toHaveBeenCalled()
  })
})
