import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  claimHeavyStepResume: vi.fn(),
  finishHeavyStepResume: vi.fn(),
  runFlowNode: vi.fn(),
}))

vi.mock("../src/integration/handlers/flow", () => ({
  runFlowNode: mocks.runFlowNode,
}))
vi.mock("../src/integration/handlers/heavy-step-runner", () => ({
  claimHeavyStepResume: mocks.claimHeavyStepResume,
  finishHeavyStepResume: mocks.finishHeavyStepResume,
}))

const { resumeHeavyStep } = await import(
  "../src/integration/handlers/heavy-step-resume"
)

const data = {
  contactInboxId: "contact-inbox-1",
  conversationId: "conversation-1",
  flowExecutionKey: "flow-execution-1",
  flowId: "flow-1",
  nodeId: "node-1",
  outcomeKey: "heavy-step-outcome-1",
  startFromStepId: "step-1",
}

const RESUME_JOB_AT = Date.parse("2026-09-26T03:00:00.000Z")

describe("resumeHeavyStep", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.finishHeavyStepResume.mockResolvedValue(undefined)
  })

  test("claims a terminal outcome and re-enters its exact flow execution", async () => {
    mocks.claimHeavyStepResume.mockResolvedValue("claimed")
    mocks.runFlowNode.mockResolvedValue(undefined)

    await resumeHeavyStep(data, { timestamp: RESUME_JOB_AT })

    // No run start carried (a job queued before the field existed): the
    // resume job's own enqueue time stands in.
    expect(mocks.runFlowNode).toHaveBeenCalledWith(data, {
      flowExecutionKey: "flow-execution-1",
      startedAt: new Date(RESUME_JOB_AT),
    })
    expect(mocks.finishHeavyStepResume).toHaveBeenCalledWith(
      expect.objectContaining({
        outcomeKey: "heavy-step-outcome-1",
        succeeded: true,
      }),
    )
  })

  test("leaves a duplicate or premature continuation as a no-op", async () => {
    mocks.claimHeavyStepResume.mockResolvedValue("pending")

    await resumeHeavyStep(data, { timestamp: RESUME_JOB_AT })

    expect(mocks.runFlowNode).not.toHaveBeenCalled()
    expect(mocks.finishHeavyStepResume).not.toHaveBeenCalled()
  })

  test("re-enters under the start of the run that queued the heavy step", async () => {
    mocks.claimHeavyStepResume.mockResolvedValue("claimed")
    mocks.runFlowNode.mockResolvedValue(undefined)
    const runStartedAt = "2026-09-26T02:59:00.000Z"

    await resumeHeavyStep(
      { ...data, runStartedAt },
      { timestamp: RESUME_JOB_AT },
    )

    expect(mocks.runFlowNode).toHaveBeenCalledWith(
      expect.objectContaining({ runStartedAt }),
      {
        flowExecutionKey: "flow-execution-1",
        startedAt: new Date(runStartedAt),
      },
    )
  })
})
