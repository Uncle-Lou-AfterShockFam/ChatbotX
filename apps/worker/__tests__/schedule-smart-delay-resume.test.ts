import { beforeEach, describe, expect, test, vi } from "vitest"

// Between a row's write and the immediate enqueue, an event can claim it
// (waitForEvent, codex probe #4) and a company stop / freeze can cancel it
// (any type, s202). Marking it scheduled then would resurrect it, so every
// type marks through the pending -> scheduled CAS on its own triggerAt, and a
// miss enqueues nothing.

const { integrationQueueAdd, smartDelayService } = vi.hoisted(() => ({
  integrationQueueAdd: vi.fn(),
  smartDelayService: {
    companyStoppedAt: vi.fn(async (): Promise<Date | null> => null),
    cancelIfNotStarted: vi.fn(async () => true),
    create: vi.fn(),
    markScheduled: vi.fn(),
    resetToPending: vi.fn(),
    upsertFollowUp: vi.fn(),
  },
}))

vi.mock("@chatbotx.io/business/smart-delay", () => ({ smartDelayService }))
vi.mock("@chatbotx.io/worker-config", () => ({
  IntegrationJobAction: {
    resumeFollowUp: "resumeFollowUp",
    resumeWait: "resumeWait",
    resumeWaitForEvent: "resumeWaitForEvent",
    sendFlow: "sendFlow",
  },
  integrationQueue: { add: integrationQueueAdd },
}))
vi.mock("../src/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { scheduleSmartDelayResume } = await import(
  "../src/integration/handlers/smart-delay"
)

const NOW = new Date("2026-09-24T12:00:00.000Z")
const props = (type: "waitForEvent" | "waitNode") => ({
  type,
  triggerAt: new Date(NOW.getTime() + 120_000),
  workspaceId: "ws-1",
  flowId: "flow-1",
  flowVersionId: "fv-1",
  conversationId: "conv-1",
  contactInboxId: "ci-1",
  connectedNodeId: "timeout-node",
  stepId: "step-1",
  eventNodeId: type === "waitForEvent" ? "event-node" : null,
  eventSpec:
    type === "waitForEvent"
      ? { eventType: "tagApplied" as const, tagId: "t" }
      : null,
})

describe("scheduleSmartDelayResume: immediate enqueue", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    smartDelayService.create.mockResolvedValue(undefined)
    integrationQueueAdd.mockResolvedValue(undefined)
  })

  test.each([
    "waitForEvent",
    "waitNode",
  ] as const)("%s: CAS on the row's own triggerAt; a miss (claimed / canceled) enqueues nothing", async (type) => {
    smartDelayService.markScheduled.mockResolvedValueOnce(false)
    await scheduleSmartDelayResume(props(type))
    expect(smartDelayService.markScheduled).toHaveBeenCalledWith({
      id: expect.any(String),
      triggerAt: new Date(NOW.getTime() + 120_000),
    })
    expect(integrationQueueAdd).not.toHaveBeenCalled()
    expect(smartDelayService.resetToPending).not.toHaveBeenCalled()
  })

  const RUN_STARTED = new Date(NOW.getTime() - 5000)

  test.each([
    "waitForEvent",
    "waitNode",
  ] as const)("%s: company stopped during this run -> the written row is canceled, never marked or enqueued", async (type) => {
    smartDelayService.companyStoppedAt.mockResolvedValueOnce(
      new Date(NOW.getTime() - 1000),
    )
    await scheduleSmartDelayResume({
      ...props(type),
      runStartedAt: RUN_STARTED,
    })
    expect(smartDelayService.companyStoppedAt).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      contactInboxId: "ci-1",
    })
    expect(smartDelayService.cancelIfNotStarted).toHaveBeenCalledWith({
      id: smartDelayService.create.mock.calls[0]?.[0].data.id,
    })
    expect(smartDelayService.markScheduled).not.toHaveBeenCalled()
    expect(integrationQueueAdd).not.toHaveBeenCalled()
  })

  test("company stopped before this run started (a flow reacting to the stop): the wait is kept", async () => {
    smartDelayService.companyStoppedAt.mockResolvedValueOnce(
      new Date(RUN_STARTED.getTime() - 1000),
    )
    smartDelayService.markScheduled.mockResolvedValueOnce(true)
    await scheduleSmartDelayResume({
      ...props("waitNode"),
      runStartedAt: RUN_STARTED,
    })
    expect(smartDelayService.cancelIfNotStarted).not.toHaveBeenCalled()
    expect(integrationQueueAdd).toHaveBeenCalledTimes(1)
  })

  test("no run start (a button tap, an inline run): no stop lookup at all", async () => {
    smartDelayService.markScheduled.mockResolvedValueOnce(true)
    await scheduleSmartDelayResume(props("waitNode"))
    expect(smartDelayService.companyStoppedAt).not.toHaveBeenCalled()
    expect(integrationQueueAdd).toHaveBeenCalledTimes(1)
  })

  test("a failing stopped-company check keeps the row (every resume re-checks)", async () => {
    smartDelayService.companyStoppedAt.mockRejectedValueOnce(
      new Error("db down"),
    )
    smartDelayService.markScheduled.mockResolvedValueOnce(true)
    await scheduleSmartDelayResume({
      ...props("waitNode"),
      runStartedAt: RUN_STARTED,
    })
    expect(smartDelayService.cancelIfNotStarted).not.toHaveBeenCalled()
    expect(integrationQueueAdd).toHaveBeenCalledTimes(1)
  })

  test.each([
    "waitForEvent",
    "waitNode",
  ] as const)("%s: still pending -> marked and enqueued", async (type) => {
    smartDelayService.markScheduled.mockResolvedValueOnce(true)
    await scheduleSmartDelayResume(props(type))
    expect(integrationQueueAdd).toHaveBeenCalledTimes(1)
  })
})
