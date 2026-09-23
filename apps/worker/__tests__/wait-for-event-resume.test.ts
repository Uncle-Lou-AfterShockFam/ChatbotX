import { beforeEach, describe, expect, test, vi } from "vitest"

const { runFlowNode, smartDelayService, queueRemove } = vi.hoisted(() => ({
  runFlowNode: vi.fn(),
  queueRemove: vi.fn(),
  smartDelayService: {
    claimForEvent: vi.fn(),
    claimForRun: vi.fn(),
    findActiveWaitForEvent: vi.fn(),
    findById: vi.fn(),
    requeueClaimedRun: vi.fn(),
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
  integrationQueue: {
    add: vi.fn(),
    remove: queueRemove,
  },
}))

vi.mock("../src/integration/handlers/flow", () => ({ runFlowNode }))

const { eventMatchesSpec, runWaitForEventResume } = await import(
  "../src/integration/handlers/wait-for-event-resume"
)

const NOW = new Date("2026-09-23T18:02:00.000Z")

const row = {
  id: "sd-1",
  workspaceId: "ws-1",
  flowId: "flow-1",
  flowVersionId: "fv-1",
  contactInboxId: "ci-1",
  appointmentId: null,
  conversationId: "conv-1",
  nodeId: "timeout-node",
  eventNodeId: "event-node",
  eventSpec: { eventType: "tagApplied", tagId: "tag-clicked" },
  stepId: "step-1",
  metadata: null,
  type: "waitForEvent",
  createdAt: new Date("2026-09-23T18:00:00.000Z"),
  triggerAt: NOW,
  status: "scheduled",
}

const tagEvent = {
  reason: "event" as const,
  workspaceId: "ws-1",
  contactId: "contact-1",
  eventType: "tagApplied" as const,
  tagId: "tag-clicked",
}

describe("runWaitForEventResume", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    smartDelayService.findById.mockResolvedValue(row)
    smartDelayService.findActiveWaitForEvent.mockResolvedValue([row])
    smartDelayService.claimForRun.mockResolvedValue(true)
    smartDelayService.claimForEvent.mockResolvedValue(true)
    smartDelayService.requeueClaimedRun.mockResolvedValue(true)
    queueRemove.mockResolvedValue(1)
  })

  test("timeout: claims the scheduled row and resumes on the timeout edge", async () => {
    await runWaitForEventResume({ reason: "timeout", smartDelayId: "sd-1" })
    expect(smartDelayService.claimForRun).toHaveBeenCalledWith({
      id: "sd-1",
      to: "completed",
    })
    expect(runFlowNode).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: "timeout-node",
        contactInboxId: "ci-1",
      }),
      { flowExecutionKey: undefined },
    )
  })

  test("timeout with no timeout edge completes the row and runs nothing", async () => {
    smartDelayService.findById.mockResolvedValueOnce({ ...row, nodeId: null })
    await runWaitForEventResume({ reason: "timeout", smartDelayId: "sd-1" })
    expect(smartDelayService.claimForRun).toHaveBeenCalledTimes(1)
    expect(runFlowNode).not.toHaveBeenCalled()
  })

  test("timeout ignores a row of another type, a future row, and a lost claim", async () => {
    smartDelayService.findById.mockResolvedValueOnce({
      ...row,
      type: "waitNode",
    })
    await runWaitForEventResume({ reason: "timeout", smartDelayId: "sd-1" })
    smartDelayService.findById.mockResolvedValueOnce({
      ...row,
      triggerAt: new Date(NOW.getTime() + 1000),
    })
    await runWaitForEventResume({ reason: "timeout", smartDelayId: "sd-1" })
    expect(smartDelayService.claimForRun).not.toHaveBeenCalled()
    smartDelayService.claimForRun.mockResolvedValueOnce(false)
    await runWaitForEventResume({ reason: "timeout", smartDelayId: "sd-1" })
    expect(runFlowNode).not.toHaveBeenCalled()
  })

  test("event: claims, removes the timeout job, resumes on the event edge", async () => {
    await runWaitForEventResume(tagEvent)
    expect(smartDelayService.findActiveWaitForEvent).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      contactId: "contact-1",
    })
    expect(smartDelayService.claimForEvent).toHaveBeenCalledWith({ id: "sd-1" })
    expect(queueRemove).toHaveBeenCalledWith(
      `smart-delay-sd-1-${NOW.getTime()}`,
    )
    expect(runFlowNode).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: "event-node" }),
      { flowExecutionKey: undefined },
    )
  })

  test("event on a still-pending row (no job yet) claims without a remove", async () => {
    smartDelayService.findActiveWaitForEvent.mockResolvedValueOnce([
      { ...row, status: "pending" },
    ])
    await runWaitForEventResume(tagEvent)
    expect(smartDelayService.claimForEvent).toHaveBeenCalledTimes(1)
    expect(queueRemove).not.toHaveBeenCalled()
    expect(runFlowNode).toHaveBeenCalledTimes(1)
  })

  test("event that lost the CAS to the timeout does nothing (no double resume)", async () => {
    smartDelayService.claimForEvent.mockResolvedValueOnce(false)
    await runWaitForEventResume(tagEvent)
    expect(queueRemove).not.toHaveBeenCalled()
    expect(runFlowNode).not.toHaveBeenCalled()
  })

  test("event that does not match the row's spec is ignored; a matching row with no event edge just completes", async () => {
    await runWaitForEventResume({ ...tagEvent, tagId: "other-tag" })
    expect(smartDelayService.claimForEvent).not.toHaveBeenCalled()
    smartDelayService.findActiveWaitForEvent.mockResolvedValueOnce([
      { ...row, eventNodeId: null },
    ])
    await runWaitForEventResume(tagEvent)
    expect(smartDelayService.claimForEvent).toHaveBeenCalledTimes(1)
    expect(runFlowNode).not.toHaveBeenCalled()
  })

  test("a failed timeout-job remove is logged, not fatal", async () => {
    queueRemove.mockRejectedValueOnce(new Error("redis down"))
    await runWaitForEventResume(tagEvent)
    expect(runFlowNode).toHaveBeenCalledTimes(1)
  })

  test("a flow failure on the EVENT path requeues the row pointed at the event edge, due now", async () => {
    runFlowNode.mockRejectedValueOnce(new Error("boom"))
    await expect(runWaitForEventResume(tagEvent)).rejects.toThrow("boom")
    expect(smartDelayService.requeueClaimedRun).toHaveBeenCalledWith({
      id: "sd-1",
      resumeAt: { nodeId: "event-node", triggerAt: NOW },
    })
  })

  test("a flow failure on the TIMEOUT path requeues the row as it is", async () => {
    runFlowNode.mockRejectedValueOnce(new Error("boom"))
    await expect(
      runWaitForEventResume({ reason: "timeout", smartDelayId: "sd-1" }),
    ).rejects.toThrow("boom")
    expect(smartDelayService.requeueClaimedRun).toHaveBeenCalledWith({
      id: "sd-1",
    })
  })

  test("a malformed stored spec never matches", async () => {
    smartDelayService.findActiveWaitForEvent.mockResolvedValueOnce([
      { ...row, eventSpec: { eventType: "tagApplied" } },
      { ...row, id: "sd-2", eventSpec: null },
    ])
    await runWaitForEventResume(tagEvent)
    expect(smartDelayService.claimForEvent).not.toHaveBeenCalled()
  })
})

describe("eventMatchesSpec", () => {
  test("matches on type + id only", () => {
    expect(
      eventMatchesSpec(
        { eventType: "tagApplied", tagId: "t" },
        { ...tagEvent, tagId: "t" },
      ),
    ).toBe(true)
    expect(
      eventMatchesSpec(
        { eventType: "customFieldChanged", customFieldId: "f" },
        {
          ...tagEvent,
          eventType: "customFieldChanged",
          tagId: undefined,
          customFieldId: "f",
        },
      ),
    ).toBe(true)
    expect(
      eventMatchesSpec(
        { eventType: "customFieldChanged", customFieldId: "f" },
        tagEvent,
      ),
    ).toBe(false)
    expect(eventMatchesSpec({ eventType: "tagApplied" }, tagEvent)).toBe(false)
  })
})
