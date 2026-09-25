import { beforeEach, describe, expect, test, vi } from "vitest"

// An event can claim a fresh waitForEvent row between its insert and the
// immediate timeout enqueue; marking it scheduled then would resurrect it and
// its timeout edge would ALSO run (codex probe #4). Only waitForEvent uses the
// pending -> scheduled CAS (followUp re-arms scheduled rows, skeptic HIGH).

const { integrationQueueAdd, smartDelayService } = vi.hoisted(() => ({
  integrationQueueAdd: vi.fn(),
  smartDelayService: {
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

  test("waitForEvent: CAS; an event that already claimed the row means no timeout job", async () => {
    smartDelayService.markScheduled.mockResolvedValueOnce(false)
    await scheduleSmartDelayResume(props("waitForEvent"))
    expect(smartDelayService.markScheduled).toHaveBeenCalledWith(
      expect.objectContaining({ ifPending: true }),
    )
    expect(integrationQueueAdd).not.toHaveBeenCalled()
    expect(smartDelayService.resetToPending).not.toHaveBeenCalled()
  })

  test("waitForEvent: still pending -> marked and enqueued", async () => {
    smartDelayService.markScheduled.mockResolvedValueOnce(true)
    await scheduleSmartDelayResume(props("waitForEvent"))
    expect(integrationQueueAdd).toHaveBeenCalledTimes(1)
  })

  test("waitNode keeps the unconditional write", async () => {
    smartDelayService.markScheduled.mockResolvedValueOnce(true)
    await scheduleSmartDelayResume(props("waitNode"))
    expect(smartDelayService.markScheduled).toHaveBeenCalledWith(
      expect.objectContaining({ ifPending: false }),
    )
    expect(integrationQueueAdd).toHaveBeenCalledTimes(1)
  })
})
