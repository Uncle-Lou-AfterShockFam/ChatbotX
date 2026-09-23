import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  enqueueIntegrationJob: vi.fn(async () => undefined),
}))

vi.mock("@chatbotx.io/worker-config", () => ({
  enqueueIntegrationJob: (...args: unknown[]) =>
    mocks.enqueueIntegrationJob(...args),
}))

const { CompanyStopEventEmitter } = await import("../src/company-stop/emitter")
const { setTriggerExecutionContext } = await import("../src/trigger/context")

describe("CompanyStopEventEmitter", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test("tagApplied enqueues a companyStopOnTag job, also from worker context", async () => {
    setTriggerExecutionContext({ source: "worker" })
    await CompanyStopEventEmitter.tagApplied(
      "ws-1",
      "contact-1",
      "tag-1",
      "ci-1",
    )
    expect(mocks.enqueueIntegrationJob).toHaveBeenCalledTimes(1)
    expect(mocks.enqueueIntegrationJob.mock.calls[0]?.[0]).toEqual({
      type: "companyStopOnTag",
      data: { workspaceId: "ws-1", contactId: "contact-1", tagId: "tag-1" },
    })
  })

  test("other event types and empty ids are ignored", async () => {
    await CompanyStopEventEmitter.tagRemoved("ws-1", "contact-1", "tag-1")
    await CompanyStopEventEmitter.customFieldChanged(
      "ws-1",
      "contact-1",
      "cf-1",
      "x",
      null,
      "y",
    )
    await CompanyStopEventEmitter.tagApplied("ws-1", "contact-1", "")
    await CompanyStopEventEmitter.tagApplied("", "contact-1", "tag-1")
    expect(mocks.enqueueIntegrationJob).not.toHaveBeenCalled()
  })
})
