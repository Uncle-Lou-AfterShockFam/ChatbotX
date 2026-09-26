import { beforeEach, describe, expect, test, vi } from "vitest"

const { runFlowNode, smartDelayService } = vi.hoisted(() => ({
  runFlowNode: vi.fn(),
  smartDelayService: {
    isContactInboxStopped: vi.fn(async () => false),
    cancelIfNotStarted: vi.fn(async () => true),
    claimRunning: vi.fn(),
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
    sendFlow: "sendFlow",
  },
  integrationQueue: {
    add: vi.fn(),
  },
}))

vi.mock("../src/integration/handlers/flow", () => ({ runFlowNode }))

const { runWaitResume } = await import(
  "../src/integration/handlers/wait-resume"
)
const { CLAIM_WRITE_ATTEMPTS } = await import(
  "../src/integration/handlers/smart-delay-run"
)

const waitRow = {
  id: "smart-delay-1",
  workspaceId: "workspace-1",
  flowId: "flow-1",
  flowVersionId: "flow-version-1",
  contactInboxId: "contact-inbox-1",
  appointmentId: null,
  conversationId: "conversation-1",
  nodeId: "next-node",
  stepId: "step-1",
  metadata: null,
  type: "waitNode",
  createdAt: new Date("2026-07-16T00:00:00.000Z"),
  triggerAt: new Date("2026-07-16T00:01:00.000Z"),
  status: "scheduled",
}

// What the service hands back from a winning claim: the row as RUNNING.
const claimed = (row: typeof waitRow) => ({
  ...row,
  status: "running",
  claimGeneration: 7,
})

describe("runWaitResume", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-16T00:01:00.000Z"))
    smartDelayService.findById.mockResolvedValue(waitRow)
    smartDelayService.claimRunning.mockResolvedValue(claimed(waitRow))
    smartDelayService.finishClaimedRun.mockResolvedValue(true)
    smartDelayService.heartbeatClaim.mockResolvedValue(true)
    smartDelayService.requeueClaimedRun.mockResolvedValue("scheduled")
  })

  test("a stopped company's contact: the claimed row is canceled with ITS generation, the flow never runs", async () => {
    smartDelayService.isContactInboxStopped.mockResolvedValueOnce(true)

    await runWaitResume({ smartDelayId: "smart-delay-1" })

    expect(smartDelayService.isContactInboxStopped).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      contactInboxId: "contact-inbox-1",
    })
    expect(runFlowNode).not.toHaveBeenCalled()
    expect(smartDelayService.finishClaimedRun).toHaveBeenCalledWith({
      id: "smart-delay-1",
      generation: 7,
      to: "canceled",
    })
    expect(smartDelayService.requeueClaimedRun).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  test("a failing stopped-company check is a flow failure: requeue + rethrow", async () => {
    smartDelayService.isContactInboxStopped.mockRejectedValueOnce(
      new Error("db down"),
    )

    await expect(
      runWaitResume({ smartDelayId: "smart-delay-1" }),
    ).rejects.toThrow("db down")
    expect(runFlowNode).not.toHaveBeenCalled()
    expect(smartDelayService.requeueClaimedRun).toHaveBeenCalledWith({
      id: "smart-delay-1",
      generation: 7,
    })
  })

  test("runs the connected node after claiming the scheduled row", async () => {
    await runWaitResume({ smartDelayId: "smart-delay-1" })

    expect(smartDelayService.claimRunning).toHaveBeenCalledWith({
      id: "smart-delay-1",
    })
    expect(runFlowNode).toHaveBeenCalledWith(
      {
        conversationId: "conversation-1",
        contactInboxId: "contact-inbox-1",
        flowId: "flow-1",
        flowVersionId: "flow-version-1",
        nodeId: "next-node",
      },
      { flowExecutionKey: undefined, claimCheck: expect.any(Function) },
    )
  })

  test("preserves broadcast metadata when resuming the connected node", async () => {
    const broadcastRow = {
      ...waitRow,
      metadata: {
        type: "broadcast",
        broadcastId: "broadcast-1",
        contactInboxId: "contact-inbox-1",
      },
    }
    smartDelayService.findById.mockResolvedValueOnce(broadcastRow)
    smartDelayService.claimRunning.mockResolvedValueOnce(claimed(broadcastRow))

    await runWaitResume({ smartDelayId: "smart-delay-1" })

    expect(runFlowNode).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: {
          type: "broadcast",
          broadcastId: "broadcast-1",
          contactInboxId: "contact-inbox-1",
        },
      }),
      { flowExecutionKey: undefined, claimCheck: expect.any(Function) },
    )
  })

  test("preserves appointmentId when resuming the connected node", async () => {
    smartDelayService.findById.mockResolvedValueOnce({
      ...waitRow,
      appointmentId: "appointment-1",
    })
    smartDelayService.claimRunning.mockResolvedValueOnce(
      claimed({ ...waitRow, appointmentId: "appointment-1" }),
    )

    await runWaitResume({ smartDelayId: "smart-delay-1" })

    expect(runFlowNode).toHaveBeenCalledWith(
      expect.objectContaining({
        appointmentId: "appointment-1",
      }),
      { flowExecutionKey: undefined, claimCheck: expect.any(Function) },
    )
  })

  test("does not run when another worker already claimed the row", async () => {
    smartDelayService.claimRunning.mockResolvedValueOnce(null)

    await runWaitResume({ smartDelayId: "smart-delay-1" })

    expect(runFlowNode).not.toHaveBeenCalled()
  })

  test("requeues the claimed row and rethrows when the resumed flow fails", async () => {
    const error = new Error("heavy step timed out")
    runFlowNode.mockRejectedValueOnce(error)

    await expect(runWaitResume({ smartDelayId: "smart-delay-1" })).rejects.toBe(
      error,
    )

    expect(smartDelayService.requeueClaimedRun).toHaveBeenCalledWith({
      id: "smart-delay-1",
      generation: 7,
    })
    expect(smartDelayService.finishClaimedRun).not.toHaveBeenCalled()
  })

  test("finishes the claimed row with ITS generation after the flow ran", async () => {
    await runWaitResume({ smartDelayId: "smart-delay-1" })

    expect(smartDelayService.finishClaimedRun).toHaveBeenCalledWith({
      id: "smart-delay-1",
      generation: 7,
    })
    expect(smartDelayService.requeueClaimedRun).not.toHaveBeenCalled()
  })

  test("runs the edge of the row the claim RETURNED, not the pre-claim snapshot", async () => {
    smartDelayService.claimRunning.mockResolvedValueOnce({
      ...waitRow,
      nodeId: "re-pointed-node",
      status: "running",
      claimGeneration: 8,
    })

    await runWaitResume({ smartDelayId: "smart-delay-1" })

    expect(runFlowNode).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: "re-pointed-node" }),
      { flowExecutionKey: undefined, claimCheck: expect.any(Function) },
    )
  })

  test("does not touch rows scheduled for the future", async () => {
    smartDelayService.findById.mockResolvedValueOnce({
      ...waitRow,
      triggerAt: new Date("2026-07-16T00:02:00.000Z"),
    })

    await runWaitResume({ smartDelayId: "smart-delay-1" })

    expect(smartDelayService.claimRunning).not.toHaveBeenCalled()
    expect(runFlowNode).not.toHaveBeenCalled()
  })

  test.each([
    null,
    { ...waitRow, type: "followUp" },
    { ...waitRow, status: "completed" },
    { ...waitRow, nodeId: null },
  ])("no-ops for non-resumable row %#", async (row) => {
    smartDelayService.findById.mockResolvedValueOnce(row)

    await runWaitResume({ smartDelayId: "smart-delay-1" })

    expect(smartDelayService.claimRunning).not.toHaveBeenCalled()
    expect(runFlowNode).not.toHaveBeenCalled()
  })
  describe("claimCheck (the runner's ownership check between steps)", () => {
    type RunOptions = { claimCheck: () => Promise<void> }
    // The resumed flow reaches one step boundary, then (if still owned) a second.
    const runTwoBoundaries = async (_data: unknown, options: RunOptions) => {
      await options.claimCheck()
      await options.claimCheck()
    }

    test("renews the claim with ITS generation at every boundary, then finishes", async () => {
      runFlowNode.mockImplementationOnce(runTwoBoundaries)

      await runWaitResume({ smartDelayId: "smart-delay-1" })

      expect(smartDelayService.heartbeatClaim).toHaveBeenCalledTimes(2)
      expect(smartDelayService.heartbeatClaim).toHaveBeenCalledWith({
        id: "smart-delay-1",
        generation: 7,
      })
      expect(smartDelayService.finishClaimedRun).toHaveBeenCalledOnce()
    })

    test("a taken-over claim stops the run: no requeue, no finish, no retry, no timer left", async () => {
      smartDelayService.heartbeatClaim.mockResolvedValueOnce(false)
      let reachedSecondBoundary = false
      runFlowNode.mockImplementationOnce(
        async (_data: unknown, options: RunOptions) => {
          await options.claimCheck()
          reachedSecondBoundary = true
        },
      )

      await expect(
        runWaitResume({ smartDelayId: "smart-delay-1" }),
      ).resolves.toBeUndefined()

      expect(reachedSecondBoundary).toBe(false)
      expect(smartDelayService.requeueClaimedRun).not.toHaveBeenCalled()
      expect(smartDelayService.finishClaimedRun).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    })

    test("a transient database error in the check is retried, not replayed", async () => {
      smartDelayService.heartbeatClaim.mockRejectedValueOnce(
        new Error("connection reset"),
      )
      runFlowNode.mockImplementationOnce(runTwoBoundaries)

      const run = runWaitResume({ smartDelayId: "smart-delay-1" })
      await vi.advanceTimersByTimeAsync(1000)
      await run

      expect(smartDelayService.heartbeatClaim).toHaveBeenCalledTimes(3)
      expect(smartDelayService.requeueClaimedRun).not.toHaveBeenCalled()
      expect(smartDelayService.finishClaimedRun).toHaveBeenCalledOnce()
    })

    test(`a check that keeps failing (${CLAIM_WRITE_ATTEMPTS} tries) is a flow failure: requeue + rethrow`, async () => {
      const dbDown = new Error("connection terminated")
      smartDelayService.heartbeatClaim.mockRejectedValue(dbDown)
      runFlowNode.mockImplementationOnce(runTwoBoundaries)

      const run = runWaitResume({ smartDelayId: "smart-delay-1" })
      const settled = expect(run).rejects.toBe(dbDown)
      await vi.advanceTimersByTimeAsync(1000)
      await settled

      expect(smartDelayService.heartbeatClaim).toHaveBeenCalledTimes(
        CLAIM_WRITE_ATTEMPTS,
      )

      expect(smartDelayService.requeueClaimedRun).toHaveBeenCalledWith({
        id: "smart-delay-1",
        generation: 7,
      })
      expect(smartDelayService.finishClaimedRun).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    })

    test("a transient database error on finish is retried, so the row does not wait for the sweep", async () => {
      smartDelayService.finishClaimedRun.mockRejectedValueOnce(
        new Error("connection reset"),
      )

      const run = runWaitResume({ smartDelayId: "smart-delay-1" })
      await vi.advanceTimersByTimeAsync(1000)
      await run

      expect(smartDelayService.finishClaimedRun).toHaveBeenCalledTimes(2)
      expect(smartDelayService.requeueClaimedRun).not.toHaveBeenCalled()
    })
  })
})
