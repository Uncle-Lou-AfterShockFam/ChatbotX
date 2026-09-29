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

describe("SmartDelayEventEmitter: form events (s220 A2-3)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const submitted = {
    formId: "form-1",
    formSlug: "intake",
    submissionId: "sub-1",
    definitionVersion: 1,
    values: { email: "a@example.com" },
  }

  test("formSubmitted enqueues with the form id only (never the answers)", async () => {
    await SmartDelayEventEmitter.formSubmitted("ws-1", "contact-1", submitted)
    expect(mocks.enqueueIntegrationJob.mock.calls[0]?.[0]).toEqual({
      type: "resumeWaitForEvent",
      data: {
        reason: "event",
        workspaceId: "ws-1",
        contactId: "contact-1",
        eventType: "formSubmitted",
        formId: "form-1",
        emittedAt: expect.any(String),
      },
    })
  })

  test("formAbandoned enqueues with the form id", async () => {
    await SmartDelayEventEmitter.formAbandoned("ws-1", "contact-1", {
      formId: "form-2",
      formSessionId: "fs-1",
      channel: "chat",
      reason: "timeout",
      lastFieldKey: null,
      askedCount: 0,
      conversationId: "conv-1",
      flowId: "flow-1",
    })
    expect(mocks.enqueueIntegrationJob.mock.calls[0]?.[0]).toMatchObject({
      data: { eventType: "formAbandoned", formId: "form-2" },
    })
  })

  test("a form event without a form id is ignored", async () => {
    await SmartDelayEventEmitter.formSubmitted("ws-1", "contact-1", {
      ...submitted,
      formId: "",
    })
    expect(mocks.enqueueIntegrationJob).not.toHaveBeenCalled()
  })

  test("a form event's occurredAt is the stale-guard instant, not the emit time", async () => {
    await SmartDelayEventEmitter.formSubmitted("ws-1", "contact-1", {
      ...submitted,
      occurredAt: "2026-09-29T01:02:03.000Z",
    })
    await SmartDelayEventEmitter.formSubmitted("ws-1", "contact-1", {
      ...submitted,
      occurredAt: "not-a-date",
    })
    const stamps = mocks.enqueueIntegrationJob.mock.calls.map(
      (call) => (call[0] as { data: { emittedAt: string } }).data.emittedAt,
    )
    expect(stamps[0]).toBe("2026-09-29T01:02:03.000Z")
    // A malformed instant falls back to now (never undefined).
    expect(Date.parse(stamps[1] ?? "")).toBeGreaterThan(
      Date.parse("2026-09-29T01:02:03.000Z"),
    )
  })
})
