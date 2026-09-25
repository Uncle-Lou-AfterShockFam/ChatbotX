import { beforeEach, describe, expect, test, vi } from "vitest"

// The waitForEvent wake-up signal must reach the integration queue from
// EVERY context (a flow step applying a tag inside the worker included) and
// must never depend on a trigger existing for the workspace.

const mocks = vi.hoisted(() => ({
  enqueueIntegrationJob: vi.fn(async () => undefined),
}))

vi.mock("@chatbotx.io/worker-config", () => ({
  enqueueIntegrationJob: (...args: unknown[]) =>
    mocks.enqueueIntegrationJob(...args),
}))

const { SmartDelayEventEmitter } = await import("../src/smart-delay/emitter")
const { setTriggerExecutionContext } = await import("../src/trigger/context")

describe("SmartDelayEventEmitter", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test("tagApplied enqueues a resumeWaitForEvent job, also from worker context", async () => {
    setTriggerExecutionContext({ source: "worker" })
    await SmartDelayEventEmitter.tagApplied(
      "ws-1",
      "contact-1",
      "tag-1",
      "ci-1",
    )
    expect(mocks.enqueueIntegrationJob).toHaveBeenCalledTimes(1)
    expect(mocks.enqueueIntegrationJob.mock.calls[0]?.[0]).toEqual({
      type: "resumeWaitForEvent",
      data: {
        reason: "event",
        workspaceId: "ws-1",
        contactId: "contact-1",
        eventType: "tagApplied",
        tagId: "tag-1",
        emittedAt: expect.any(String),
      },
    })
  })

  test("every event carries emittedAt = the instant it fired (ISO), so a retried job cannot resume a wait created later", async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date("2026-09-25T15:00:00.000Z"))
      await SmartDelayEventEmitter.tagApplied("ws-1", "contact-1", "tag-1")
      const payload = mocks.enqueueIntegrationJob.mock.calls[0]?.[0] as {
        data: { emittedAt?: string }
      }
      expect(payload.data.emittedAt).toBe("2026-09-25T15:00:00.000Z")
    } finally {
      vi.useRealTimers()
    }
  })

  test("customFieldChanged enqueues with the field id and no tag", async () => {
    await SmartDelayEventEmitter.customFieldChanged(
      "ws-1",
      "contact-1",
      "cf-1",
      "bt_verdict",
      null,
      "ok",
    )
    expect(mocks.enqueueIntegrationJob.mock.calls[0]?.[0]).toEqual({
      type: "resumeWaitForEvent",
      data: {
        reason: "event",
        workspaceId: "ws-1",
        contactId: "contact-1",
        eventType: "customFieldChanged",
        customFieldId: "cf-1",
        newValue: "ok",
        emittedAt: expect.any(String),
      },
    })
  })

  test("customFieldChanged carries the new value: text as is, a clear as null, anything else as JSON", async () => {
    await SmartDelayEventEmitter.customFieldChanged(
      "ws-1",
      "contact-1",
      "cf-1",
      "wp_paid_order_id",
      "3634",
      null,
    )
    await SmartDelayEventEmitter.customFieldChanged(
      "ws-1",
      "contact-1",
      "cf-1",
      "n",
      null,
      42 as unknown as string,
    )
    const values = mocks.enqueueIntegrationJob.mock.calls.map(
      (call) => (call[0] as { data: { newValue?: unknown } }).data.newValue,
    )
    expect(values).toEqual([null, "42"])
  })

  test("other event types and empty ids are ignored", async () => {
    await SmartDelayEventEmitter.tagRemoved("ws-1", "contact-1", "tag-1")
    await SmartDelayEventEmitter.tagApplied("ws-1", "contact-1", "")
    await SmartDelayEventEmitter.tagApplied("", "contact-1", "tag-1")
    expect(mocks.enqueueIntegrationJob).not.toHaveBeenCalled()
  })
})
