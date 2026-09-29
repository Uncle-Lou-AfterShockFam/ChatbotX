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
        inboxId: "in-1",
        messageId: "outbox:ob_7",
        status: "delivered",
      }),
    ).resolves.toBe(true)
    expect(newsletterRef).toHaveBeenCalledWith({ inboxId: "in-1", id: "ob_7" })
    expect(markDelivered).toHaveBeenCalledWith("tok-1")
    await settleLineEmailStatus({
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
        settleLineEmailStatus({ inboxId: "in-1", messageId, status }),
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
