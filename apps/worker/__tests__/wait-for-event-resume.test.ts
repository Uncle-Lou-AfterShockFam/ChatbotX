import { beforeEach, describe, expect, test, vi } from "vitest"

const { runFlowNode, smartDelayService, queueRemove } = vi.hoisted(() => ({
  runFlowNode: vi.fn(),
  queueRemove: vi.fn(),
  smartDelayService: {
    claimForEvent: vi.fn(),
    claimRunning: vi.fn(),
    findActiveWaitForEvent: vi.fn(),
    findById: vi.fn(),
    finishClaimedRun: vi.fn(),
    heartbeatClaim: vi.fn(),
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

const { eventMatchesSpec, eventPrecedesRow, runWaitForEventResume } =
  await import("../src/integration/handlers/wait-for-event-resume")

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
  claimGeneration: 0,
  claimedAt: null,
}

const tagEvent = {
  reason: "event" as const,
  workspaceId: "ws-1",
  contactId: "contact-1",
  eventType: "tagApplied" as const,
  tagId: "tag-clicked",
  emittedAt: NOW.toISOString(),
}

const fieldEvent = {
  reason: "event" as const,
  workspaceId: "ws-1",
  contactId: "contact-1",
  eventType: "customFieldChanged" as const,
  customFieldId: "f",
  emittedAt: NOW.toISOString(),
}

// What the service hands back from a winning claim: the row as RUNNING with
// a bumped generation; the event claim also re-points nodeId at the event edge.
const claimedByTimeout = (base: typeof row) => ({
  ...base,
  status: "running",
  claimGeneration: base.claimGeneration + 1,
  claimedAt: NOW,
})
const claimedByEvent = (base: typeof row) => ({
  ...claimedByTimeout(base),
  nodeId: base.eventNodeId,
  triggerAt: NOW,
})

describe("runWaitForEventResume", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    smartDelayService.findById.mockResolvedValue(row)
    smartDelayService.findActiveWaitForEvent.mockResolvedValue([row])
    smartDelayService.claimRunning.mockImplementation(
      ({ id }: { id: string }) =>
        Promise.resolve(claimedByTimeout({ ...row, id })),
    )
    smartDelayService.claimForEvent.mockImplementation(
      ({ id }: { id: string }) =>
        Promise.resolve(claimedByEvent({ ...row, id })),
    )
    smartDelayService.finishClaimedRun.mockResolvedValue(true)
    smartDelayService.heartbeatClaim.mockResolvedValue(true)
    smartDelayService.requeueClaimedRun.mockResolvedValue(true)
    queueRemove.mockResolvedValue(1)
  })

  test("HOSTILE (skeptic HIGH): a slow but ALIVE run renews its claim every 2 min so the 10-min sweep never re-runs it; renewal stops with the run", async () => {
    let finish: () => void = () => {}
    runFlowNode.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finish = resolve)),
    )
    const run = runWaitForEventResume(tagEvent)
    await vi.advanceTimersByTimeAsync(11 * 60 * 1000) // past the sweep grace
    expect(smartDelayService.heartbeatClaim.mock.calls.length).toBe(5)
    expect(smartDelayService.heartbeatClaim).toHaveBeenLastCalledWith({
      id: "sd-1",
      generation: 1,
    })
    expect(smartDelayService.finishClaimedRun).not.toHaveBeenCalled()
    finish()
    await run
    expect(smartDelayService.finishClaimedRun).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    expect(smartDelayService.heartbeatClaim.mock.calls.length).toBe(5) // cleared
  })

  test("the heartbeat also stops when the flow throws, and a failed renewal never aborts the run", async () => {
    smartDelayService.heartbeatClaim
      .mockRejectedValueOnce(new Error("db blip"))
      .mockResolvedValueOnce(false)
    runFlowNode.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) =>
          setTimeout(() => reject(new Error("boom")), 5 * 60 * 1000),
        ),
    )
    const run = runWaitForEventResume(tagEvent)
    const settled = run.catch((error: Error) => error.message)
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    await expect(settled).resolves.toBe("boom")
    expect(smartDelayService.heartbeatClaim).toHaveBeenCalledTimes(2)
    expect(smartDelayService.requeueClaimedRun).toHaveBeenCalledWith({
      id: "sd-1",
      generation: 1,
    })
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    expect(smartDelayService.heartbeatClaim).toHaveBeenCalledTimes(2)
  })

  test("timeout: claims the scheduled row as running and resumes on the timeout edge, then finishes THAT generation", async () => {
    await runWaitForEventResume({ reason: "timeout", smartDelayId: "sd-1" })
    expect(smartDelayService.claimRunning).toHaveBeenCalledWith({ id: "sd-1" })
    expect(smartDelayService.finishClaimedRun).toHaveBeenCalledWith({
      id: "sd-1",
      generation: 1,
    })
    expect(runFlowNode).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: "timeout-node",
        contactInboxId: "ci-1",
      }),
      { flowExecutionKey: undefined },
    )
  })

  test("timeout with no timeout edge claims, finishes the row and runs nothing", async () => {
    smartDelayService.findById.mockResolvedValue({ ...row, nodeId: null })
    smartDelayService.claimRunning.mockResolvedValueOnce(
      claimedByTimeout({ ...row, nodeId: null }),
    )
    await runWaitForEventResume({ reason: "timeout", smartDelayId: "sd-1" })
    expect(smartDelayService.claimRunning).toHaveBeenCalledTimes(1)
    expect(smartDelayService.finishClaimedRun).toHaveBeenCalledWith({
      id: "sd-1",
      generation: 1,
    })
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
    expect(smartDelayService.claimRunning).not.toHaveBeenCalled()
    smartDelayService.claimRunning.mockResolvedValueOnce(null)
    await runWaitForEventResume({ reason: "timeout", smartDelayId: "sd-1" })
    expect(runFlowNode).not.toHaveBeenCalled()
    expect(smartDelayService.finishClaimedRun).not.toHaveBeenCalled()
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
    expect(smartDelayService.finishClaimedRun).toHaveBeenCalledWith({
      id: "sd-1",
      generation: 1,
    })
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
    smartDelayService.claimForEvent.mockResolvedValueOnce(null)
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
    smartDelayService.claimForEvent.mockResolvedValueOnce(
      claimedByEvent({ ...row, eventNodeId: null }),
    )
    await runWaitForEventResume(tagEvent)
    expect(smartDelayService.claimForEvent).toHaveBeenCalledTimes(1)
    expect(runFlowNode).not.toHaveBeenCalled()
    // The claimed row (no edge) is closed with its generation, never left running.
    expect(smartDelayService.finishClaimedRun).toHaveBeenCalledWith({
      id: "sd-1",
      generation: 1,
    })
  })

  test("a failed timeout-job remove is logged, not fatal", async () => {
    queueRemove.mockRejectedValueOnce(new Error("redis down"))
    await runWaitForEventResume(tagEvent)
    expect(runFlowNode).toHaveBeenCalledTimes(1)
  })

  test("a flow failure on the EVENT path requeues the row with the generation it claimed (the edge is already on the row)", async () => {
    runFlowNode.mockRejectedValueOnce(new Error("boom"))
    await expect(runWaitForEventResume(tagEvent)).rejects.toThrow("boom")
    expect(smartDelayService.requeueClaimedRun).toHaveBeenCalledWith({
      id: "sd-1",
      generation: 1,
    })
    expect(smartDelayService.finishClaimedRun).not.toHaveBeenCalled()
  })

  test("a flow failure on the TIMEOUT path requeues the row with its generation", async () => {
    runFlowNode.mockRejectedValueOnce(new Error("boom"))
    await expect(
      runWaitForEventResume({ reason: "timeout", smartDelayId: "sd-1" }),
    ).rejects.toThrow("boom")
    expect(smartDelayService.requeueClaimedRun).toHaveBeenCalledWith({
      id: "sd-1",
      generation: 1,
    })
  })

  test("HOSTILE #1: a crash between the claim and the run leaves the row RUNNING (recoverable), never completed", async () => {
    // Simulate the worker dying right after the claim: runFlowNode never
    // returns (the process is gone). What the claim wrote is all the DB has.
    let persisted: { status: string; nodeId: string | null } | undefined
    smartDelayService.claimForEvent.mockImplementationOnce(
      ({ id }: { id: string }) => {
        persisted = claimedByEvent({ ...row, id })
        // Kill the worker "here": nothing after the claim executes.
        return Promise.reject(new Error("SIGKILL after claim"))
      },
    )
    await expect(runWaitForEventResume(tagEvent)).rejects.toThrow(
      "SIGKILL after claim",
    )
    expect(persisted?.status).toBe("running")
    expect(persisted?.nodeId).toBe("event-node")
    expect(runFlowNode).not.toHaveBeenCalled()
    expect(smartDelayService.finishClaimedRun).not.toHaveBeenCalled()
    expect(smartDelayService.requeueClaimedRun).not.toHaveBeenCalled()
  })

  test("HOSTILE #3: a retried event job never resumes a wait CREATED AFTER the event fired", async () => {
    const newerWait = {
      ...row,
      id: "sd-new",
      createdAt: new Date(NOW.getTime() + 60_000),
    }
    smartDelayService.findActiveWaitForEvent.mockResolvedValueOnce([newerWait])
    await runWaitForEventResume(tagEvent) // emittedAt = NOW < createdAt
    expect(smartDelayService.claimForEvent).not.toHaveBeenCalled()
    expect(runFlowNode).not.toHaveBeenCalled()

    // The same event, replayed AFTER the wait existed, still matches it.
    smartDelayService.findActiveWaitForEvent.mockResolvedValueOnce([newerWait])
    await runWaitForEventResume({
      ...tagEvent,
      emittedAt: new Date(NOW.getTime() + 61_000).toISOString(),
    })
    expect(smartDelayService.claimForEvent).toHaveBeenCalledWith({
      id: "sd-new",
    })
  })

  test("HOSTILE #3b: an event job without emittedAt (pre-deploy) fails closed", async () => {
    const { emittedAt: _dropped, ...legacyEvent } = tagEvent
    await runWaitForEventResume(legacyEvent)
    expect(smartDelayService.claimForEvent).not.toHaveBeenCalled()
    await runWaitForEventResume({ ...tagEvent, emittedAt: "not a date" })
    expect(smartDelayService.claimForEvent).not.toHaveBeenCalled()
  })

  test("a finish whose claim is no longer current is logged, never retried into a resurrect", async () => {
    smartDelayService.finishClaimedRun.mockResolvedValueOnce(false)
    await expect(runWaitForEventResume(tagEvent)).resolves.toBeUndefined()
    expect(smartDelayService.requeueClaimedRun).not.toHaveBeenCalled()
  })

  test("value-scoped waits: paying order B resumes only the row waiting for B", async () => {
    const rowA = {
      ...row,
      id: "sd-a",
      eventSpec: {
        eventType: "customFieldChanged",
        customFieldId: "cf-paid",
        matchValue: "3635",
      },
    }
    const rowB = {
      ...rowA,
      id: "sd-b",
      eventSpec: { ...rowA.eventSpec, matchValue: "3636" },
    }
    smartDelayService.findActiveWaitForEvent.mockResolvedValueOnce([rowA, rowB])
    await runWaitForEventResume({
      ...fieldEvent,
      customFieldId: "cf-paid",
      newValue: "3636",
    })
    expect(smartDelayService.claimForEvent).toHaveBeenCalledTimes(1)
    expect(smartDelayService.claimForEvent).toHaveBeenCalledWith({
      id: "sd-b",
    })
    expect(runFlowNode).toHaveBeenCalledTimes(1)
  })

  test("timeout: runs the edge of the row the claim RETURNED, not its pre-claim snapshot (a failed event resume re-pointed it)", async () => {
    smartDelayService.findById.mockResolvedValueOnce(row)
    smartDelayService.claimRunning.mockResolvedValueOnce(
      claimedByTimeout({ ...row, nodeId: "event-node" }),
    )
    await runWaitForEventResume({ reason: "timeout", smartDelayId: "sd-1" })
    expect(smartDelayService.findById).toHaveBeenCalledTimes(1) // no re-read
    expect(runFlowNode).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(runFlowNode.mock.calls[0])).toContain("event-node")
    expect(JSON.stringify(runFlowNode.mock.calls[0])).not.toContain(
      "timeout-node",
    )
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

describe("eventPrecedesRow", () => {
  const createdAt = new Date("2026-09-25T15:00:00.000Z")
  test("true only when the event fired at or after the wait was created", () => {
    expect(
      eventPrecedesRow(
        { emittedAt: "2026-09-25T15:00:00.000Z" },
        { createdAt },
      ),
    ).toBe(true)
    expect(
      eventPrecedesRow(
        { emittedAt: "2026-09-25T15:00:01.000Z" },
        { createdAt },
      ),
    ).toBe(true)
    expect(
      eventPrecedesRow(
        { emittedAt: "2026-09-25T14:59:59.999Z" },
        { createdAt },
      ),
    ).toBe(false)
  })
  test("fails closed on a missing or malformed instant", () => {
    expect(eventPrecedesRow({}, { createdAt })).toBe(false)
    expect(eventPrecedesRow({ emittedAt: "" }, { createdAt })).toBe(false)
    expect(eventPrecedesRow({ emittedAt: "yesterday" }, { createdAt })).toBe(
      false,
    )
    expect(
      eventPrecedesRow({ emittedAt: 1 as unknown as string }, { createdAt }),
    ).toBe(false)
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

describe("eventMatchesSpec: matchValue", () => {
  const spec = {
    eventType: "customFieldChanged" as const,
    customFieldId: "f",
    matchValue: "3635",
  }

  test("matches only when the field changed TO the captured value", () => {
    expect(eventMatchesSpec(spec, { ...fieldEvent, newValue: "3635" })).toBe(
      true,
    )
    expect(
      eventMatchesSpec(spec, { ...fieldEvent, newValue: "  3635\n" }),
    ).toBe(true)
    expect(eventMatchesSpec(spec, { ...fieldEvent, newValue: "3636" })).toBe(
      false,
    )
    expect(eventMatchesSpec(spec, { ...fieldEvent, newValue: "36350" })).toBe(
      false,
    )
    expect(
      eventMatchesSpec(spec, {
        ...fieldEvent,
        customFieldId: "other",
        newValue: "3635",
      }),
    ).toBe(false)
  })

  test("fails closed: cleared field, no newValue (pre-deploy job), empty captured value", () => {
    expect(eventMatchesSpec(spec, { ...fieldEvent, newValue: null })).toBe(
      false,
    )
    expect(eventMatchesSpec(spec, fieldEvent)).toBe(false)
    expect(
      eventMatchesSpec(
        { ...spec, matchValue: "" },
        { ...fieldEvent, newValue: "" },
      ),
    ).toBe(false)
  })

  test("a row without matchValue still matches any change (legacy rows)", () => {
    const { matchValue: _unused, ...legacy } = spec
    expect(eventMatchesSpec(legacy, { ...fieldEvent, newValue: "x" })).toBe(
      true,
    )
    expect(eventMatchesSpec(legacy, fieldEvent)).toBe(true)
  })

  test("adversarial: long values and unresolved placeholders compare literally", () => {
    const long = "9".repeat(500)
    expect(
      eventMatchesSpec(
        { ...spec, matchValue: long },
        { ...fieldEvent, newValue: long },
      ),
    ).toBe(true)
    expect(
      eventMatchesSpec(
        { ...spec, matchValue: long },
        { ...fieldEvent, newValue: `${long}9` },
      ),
    ).toBe(false)
    expect(
      eventMatchesSpec(
        { ...spec, matchValue: "3635" },
        { ...fieldEvent, newValue: "{{raw:wp_order_id}}" },
      ),
    ).toBe(false)
  })
})
