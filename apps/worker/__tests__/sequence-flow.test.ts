import type { Job } from "bullmq"
import { beforeEach, describe, expect, test, vi } from "vitest"

// ---------- scheduler / redis spies ----------
// removeFromScheduleSpy is accessed at instance-creation time (during tests,
// not at import time), so vi.hoisted is not needed.
const removeFromScheduleSpy = vi.fn()
const addToScheduleSpy = vi.fn()

vi.mock("@chatbotx.io/scheduler", () => ({
  SchedulerClient: class MockSchedulerClient {
    removeFromSchedule = removeFromScheduleSpy
    addToSchedule = addToScheduleSpy
  },
}))

vi.mock("@chatbotx.io/redis", () => ({
  sequenceConnections: {
    useExisting: vi.fn().mockResolvedValue({}),
  },
}))

// ---------- sequence-scheduler spies ----------
const advanceEnrollmentSpy = vi.fn()
const { MockEnrollmentNotFoundError } = vi.hoisted(() => ({
  MockEnrollmentNotFoundError: class extends Error {},
}))

vi.mock("@chatbotx.io/sequence-scheduler", () => ({
  advanceEnrollment: (...args: unknown[]) => advanceEnrollmentSpy(...args),
  EnrollmentNotFoundError: MockEnrollmentNotFoundError,
}))

// ---------- contactSequenceService spies ----------
// sequence-flow.ts now delegates all dispatch persistence to
// contactSequenceService.{findDispatchForSend,findRunningDispatch,
// markDispatchCompleted,markDispatchCanceled,markDispatchFailed}.
// findDispatchForSend = the job's first load (running or completed, s236);
// findRunningDispatch = the re-read right before sending.
const findForSendSpy = vi.fn()
const findRunningSpy = vi.fn()
const markCompletedSpy = vi.fn()
const markCanceledSpy = vi.fn()
const markFailedSpy = vi.fn()
const deferIfPausedSpy = vi.fn()
const holdEnrollmentSpy = vi.fn()
const missingHoldFieldsSpy = vi.fn()

vi.mock("@chatbotx.io/business/contact-sequence", () => ({
  contactSequenceService: {
    findDispatchForSend: (...args: unknown[]) => findForSendSpy(...args),
    findRunningDispatch: (...args: unknown[]) => findRunningSpy(...args),
    markDispatchCompleted: (...args: unknown[]) => markCompletedSpy(...args),
    markDispatchCanceled: (...args: unknown[]) => markCanceledSpy(...args),
    markDispatchFailed: (...args: unknown[]) => markFailedSpy(...args),
    deferIfPaused: (...args: unknown[]) => deferIfPausedSpy(...args),
    holdEnrollment: (...args: unknown[]) => holdEnrollmentSpy(...args),
  },
}))

vi.mock("../src/integration/handlers/sequence-hold", () => ({
  missingHoldFields: (...args: unknown[]) => missingHoldFieldsSpy(...args),
}))

// ---------- step executor spy (module-level singleton in source) ----------
// Must use vi.hoisted() so the spies exist before the class field initializers
// fire at module-import time (sequence-flow.ts does `new StepExecutorService()`
// at module level, which runs before regular const declarations are initialized).
const { fetchStepSpy, validateStepSpy } = vi.hoisted(() => ({
  fetchStepSpy: vi.fn(),
  validateStepSpy: vi.fn(),
}))

vi.mock("../src/sequence-scheduler/services/step-executor.service", () => ({
  StepExecutorService: class MockStepExecutorService {
    fetchStep = fetchStepSpy
    validateStep = validateStepSpy
  },
}))

// ---------- send-flow-direct spy ----------
const sendFlowDirectSpy = vi.fn()

vi.mock("../src/integration/handlers/send-flow-direct", () => ({
  sendFlowDirect: (...args: unknown[]) => sendFlowDirectSpy(...args),
}))

// ---------- logger spy ----------
const loggerErrorSpy = vi.fn()

const loggerInfoSpy = vi.fn()

vi.mock("../src/lib/logger", () => ({
  logger: {
    error: (...args: unknown[]) => loggerErrorSpy(...args),
    info: (...args: unknown[]) => loggerInfoSpy(...args),
  },
}))

import { handleSendSequenceFlow } from "../src/integration/handlers/sequence-flow"

// ---------- fixtures ----------

function makeData(
  overrides: Record<string, unknown> = {},
): Parameters<typeof handleSendSequenceFlow>[0] {
  return {
    dispatchId: "dispatch-1",
    workspaceId: "ws-1",
    stepId: "step-1",
    bucket: 42,
    contactId: "contact-1",
    sequenceId: "seq-1",
    enrollmentId: "enroll-1",
    metadata: {},
    ...overrides,
  } as unknown as Parameters<typeof handleSendSequenceFlow>[0]
}

const JOB_TIMESTAMP = 1_790_000_000_000

function makeJob(
  overrides: Partial<{
    attemptsMade: number
    attempts: number
    id: string
  }> = {},
): Job {
  const { attemptsMade = 0, attempts = 3, id = "job-1" } = overrides
  return {
    id,
    attemptsMade,
    opts: { attempts },
    timestamp: JOB_TIMESTAMP,
  } as unknown as Job
}

function makeDispatch(overrides: Record<string, unknown> = {}) {
  return {
    id: "dispatch-1",
    workspaceId: "ws-1",
    status: "running",
    completedAt: null,
    contactInboxId: "ci-pinned",
    ...overrides,
  }
}

function makeStep(overrides: Record<string, unknown> = {}) {
  return {
    id: "step-1",
    order: 1,
    isActive: true,
    flow: { id: "flow-1" },
    ...overrides,
  }
}

beforeEach(() => {
  // sequence-scheduler defaults
  findForSendSpy.mockResolvedValue(makeDispatch())
  findRunningSpy.mockResolvedValue(makeDispatch())
  markCompletedSpy.mockResolvedValue(undefined)
  markCanceledSpy.mockResolvedValue(undefined)
  markFailedSpy.mockResolvedValue(undefined)
  deferIfPausedSpy.mockResolvedValue(null)
  missingHoldFieldsSpy.mockResolvedValue([])
  holdEnrollmentSpy.mockResolvedValue(true)

  // scheduler defaults
  removeFromScheduleSpy.mockResolvedValue(undefined)
  advanceEnrollmentSpy.mockResolvedValue(undefined)

  // step executor defaults
  const step = makeStep()
  fetchStepSpy.mockResolvedValue(step)
  validateStepSpy.mockReturnValue({ valid: true, step })

  // send-flow-direct default
  sendFlowDirectSpy.mockResolvedValue({ companyStopped: false })
})

// ---------- tests ----------

describe("handleSendSequenceFlow", () => {
  describe("company stopped — the run sent nothing", () => {
    test("cancels the dispatch, unschedules it and never advances the enrollment", async () => {
      sendFlowDirectSpy.mockResolvedValueOnce({ companyStopped: true })

      await handleSendSequenceFlow(makeData(), makeJob())

      expect(markCanceledSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          dispatchId: "dispatch-1",
          reason: "company_stopped",
        }),
      )
      expect(markCompletedSpy).not.toHaveBeenCalled()
      expect(advanceEnrollmentSpy).not.toHaveBeenCalled()
      expect(removeFromScheduleSpy).toHaveBeenCalledOnce()
    })
  })

  describe("enrolment paused by an out-of-office (s226b)", () => {
    test("the step is held at the pause end: re-scheduled, never sent, completed or advanced", async () => {
      deferIfPausedSpy.mockResolvedValueOnce({ bucket: 42, runAtMs: 1_800_000 })

      await handleSendSequenceFlow(makeData(), makeJob())

      expect(deferIfPausedSpy).toHaveBeenCalledWith({
        dispatchId: "dispatch-1",
        workspaceId: expect.any(String),
      })
      expect(addToScheduleSpy).toHaveBeenCalledWith(42, "dispatch-1", 1_800_000)
      expect(sendFlowDirectSpy).not.toHaveBeenCalled()
      expect(markCompletedSpy).not.toHaveBeenCalled()
      expect(advanceEnrollmentSpy).not.toHaveBeenCalled()
      expect(removeFromScheduleSpy).not.toHaveBeenCalled()
    })
  })

  describe("step fields missing: the enrolment is held (s227b H3)", () => {
    test("holds with the reason; the flow never runs, nothing completes or advances", async () => {
      const step = makeStep({ holdOnMissing: ["first_name", "company"] })
      fetchStepSpy.mockResolvedValueOnce(step)
      validateStepSpy.mockReturnValueOnce({ valid: true, step })
      missingHoldFieldsSpy.mockResolvedValueOnce(["first_name", "company"])

      await handleSendSequenceFlow(makeData(), makeJob())

      expect(missingHoldFieldsSpy).toHaveBeenCalledWith({
        holdOnMissing: ["first_name", "company"],
        contactId: "contact-1",
        contactInboxId: expect.any(String),
      })
      expect(holdEnrollmentSpy).toHaveBeenCalledWith({
        dispatchId: "dispatch-1",
        workspaceId: "ws-1",
        reason: "missing: first_name, company",
      })
      expect(sendFlowDirectSpy).not.toHaveBeenCalled()
      expect(markCompletedSpy).not.toHaveBeenCalled()
      expect(markCanceledSpy).not.toHaveBeenCalled()
      expect(advanceEnrollmentSpy).not.toHaveBeenCalled()
      expect(removeFromScheduleSpy).toHaveBeenCalledWith(42, "dispatch-1")
    })

    test("nothing to hold (no longer running / not active): canceled, never sent", async () => {
      missingHoldFieldsSpy.mockResolvedValueOnce(["first_name"])
      holdEnrollmentSpy.mockResolvedValueOnce(false)

      await handleSendSequenceFlow(makeData(), makeJob())

      expect(markCanceledSpy).toHaveBeenCalledWith({
        dispatchId: "dispatch-1",
        workspaceId: "ws-1",
        reason: "not_active",
      })
      expect(sendFlowDirectSpy).not.toHaveBeenCalled()
      expect(advanceEnrollmentSpy).not.toHaveBeenCalled()
    })

    test("an out-of-office pause wins: a paused step is deferred before any hold check", async () => {
      deferIfPausedSpy.mockResolvedValueOnce({ bucket: 42, runAtMs: 1_800_000 })

      await handleSendSequenceFlow(makeData(), makeJob())

      expect(missingHoldFieldsSpy).not.toHaveBeenCalled()
      expect(holdEnrollmentSpy).not.toHaveBeenCalled()
    })

    test("all fields present: the step sends as before", async () => {
      await handleSendSequenceFlow(makeData(), makeJob())

      expect(holdEnrollmentSpy).not.toHaveBeenCalled()
      expect(sendFlowDirectSpy).toHaveBeenCalledOnce()
    })
  })

  describe("enrolment removed while the step was looked up (s220b)", () => {
    test("the re-read before sending misses the dispatch: nothing is sent", async () => {
      findRunningSpy.mockResolvedValueOnce(undefined)

      await handleSendSequenceFlow(makeData(), makeJob())

      expect(sendFlowDirectSpy).not.toHaveBeenCalled()
      expect(markCompletedSpy).not.toHaveBeenCalled()
      expect(advanceEnrollmentSpy).not.toHaveBeenCalled()
      expect(removeFromScheduleSpy).toHaveBeenCalledWith(42, "dispatch-1")
    })
  })

  describe("enrolment removed while the step was sending (s220b)", () => {
    test("is benign: completes, unschedules, never throws or retries", async () => {
      advanceEnrollmentSpy.mockRejectedValueOnce(
        new MockEnrollmentNotFoundError("Enrollment enroll-1 not found"),
      )

      await expect(
        handleSendSequenceFlow(makeData(), makeJob()),
      ).resolves.toBeUndefined()

      expect(markCompletedSpy).toHaveBeenCalledOnce()
      expect(removeFromScheduleSpy).toHaveBeenCalledWith(42, "dispatch-1")
      expect(loggerErrorSpy).not.toHaveBeenCalled()
      expect(loggerInfoSpy).toHaveBeenCalledOnce()
    })

    test("any other advance failure still rethrows for a BullMQ retry", async () => {
      advanceEnrollmentSpy.mockRejectedValueOnce(new Error("db down"))

      await expect(
        handleSendSequenceFlow(makeData(), makeJob()),
      ).rejects.toThrow("db down")
      expect(loggerErrorSpy).toHaveBeenCalled()
    })
  })

  describe("happy path — fresh dispatch (no completedAt)", () => {
    test("calls sendFlowDirect then marks dispatch completed", async () => {
      // Act
      await handleSendSequenceFlow(makeData(), makeJob())

      // Assert
      expect(sendFlowDirectSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          flowId: "flow-1",
          workspaceId: "ws-1",
          contactId: "contact-1",
          // One run per step, on the dispatch's own inbox (owner s220b).
          contactInboxId: "ci-pinned",
          // The sequence job opens the run: the stop guard's start.
          startedAt: new Date(JOB_TIMESTAMP),
        }),
      )
      expect(markCompletedSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          dispatchId: "dispatch-1",
          workspaceId: "ws-1",
          sentAt: expect.any(Date),
        }),
      )
    })

    test("calls advanceEnrollment with correct enrollment + step info", async () => {
      // Act
      await handleSendSequenceFlow(makeData(), makeJob())

      // Assert
      expect(advanceEnrollmentSpy).toHaveBeenCalledTimes(1)
      expect(advanceEnrollmentSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          enrollmentId: "enroll-1",
          workspaceId: "ws-1",
          sequenceId: "seq-1",
          contactId: "contact-1",
          currentStep: { id: "step-1", order: 1 },
        }),
      )
    })

    test("removes the dispatch from the schedule bucket", async () => {
      // Act
      await handleSendSequenceFlow(makeData(), makeJob())

      // Assert
      expect(removeFromScheduleSpy).toHaveBeenCalledWith(42, "dispatch-1")
    })
  })

  describe("retry after the send (s236): the dispatch is already completed", () => {
    const completedAt = new Date("2025-01-01T10:00:00Z")
    beforeEach(() => {
      findForSendSpy.mockResolvedValue(
        makeDispatch({ status: "completed", completedAt }),
      )
    })

    test("never sends again; advances from the send time, guarded by this dispatch", async () => {
      await handleSendSequenceFlow(makeData(), makeJob({ attemptsMade: 1 }))

      expect(sendFlowDirectSpy).not.toHaveBeenCalled()
      expect(markCompletedSpy).not.toHaveBeenCalled()
      expect(deferIfPausedSpy).not.toHaveBeenCalled()
      expect(advanceEnrollmentSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sentAt: completedAt,
          currentStep: { id: "step-1", order: 1 },
          afterDispatchId: "dispatch-1",
        }),
      )
      expect(removeFromScheduleSpy).toHaveBeenCalledWith(42, "dispatch-1")
    })

    test("its step became invalid: the advance is still guarded by this dispatch", async () => {
      fetchStepSpy.mockResolvedValue(makeStep({ isActive: false }))
      validateStepSpy.mockReturnValue({ valid: false, reason: "step_inactive" })

      await handleSendSequenceFlow(makeData(), makeJob({ attemptsMade: 1 }))

      expect(sendFlowDirectSpy).not.toHaveBeenCalled()
      // It was sent: never re-labelled canceled, and the delay counts from the send.
      expect(markCanceledSpy).not.toHaveBeenCalled()
      expect(advanceEnrollmentSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          afterDispatchId: "dispatch-1",
          sentAt: completedAt,
        }),
      )
    })
  })

  describe("a running dispatch is never treated as a retry", () => {
    test("the advance carries no afterDispatchId", async () => {
      await handleSendSequenceFlow(makeData(), makeJob())

      expect(sendFlowDirectSpy).toHaveBeenCalledOnce()
      expect(advanceEnrollmentSpy.mock.calls[0]?.[0]).not.toHaveProperty(
        "afterDispatchId",
      )
    })
  })

  describe("dispatch not found", () => {
    test("returns early without touching db, scheduler, or advanceEnrollment", async () => {
      // Arrange
      findForSendSpy.mockResolvedValue(undefined)

      // Act
      await handleSendSequenceFlow(makeData(), makeJob())

      // Assert
      expect(markCompletedSpy).not.toHaveBeenCalled()
      expect(markCanceledSpy).not.toHaveBeenCalled()
      expect(markFailedSpy).not.toHaveBeenCalled()
      expect(sendFlowDirectSpy).not.toHaveBeenCalled()
      expect(advanceEnrollmentSpy).not.toHaveBeenCalled()
      expect(removeFromScheduleSpy).not.toHaveBeenCalled()
    })
  })

  describe("step invalid — step exists in db", () => {
    beforeEach(() => {
      const step = makeStep({ isActive: false })
      fetchStepSpy.mockResolvedValue(step)
      validateStepSpy.mockReturnValue({ valid: false, reason: "step_inactive" })
    })

    test("marks dispatch canceled with the validation reason", async () => {
      // Act
      await handleSendSequenceFlow(makeData(), makeJob())

      // Assert
      expect(markCanceledSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          dispatchId: "dispatch-1",
          workspaceId: "ws-1",
          reason: "step_inactive",
        }),
      )
    })

    test("still calls advanceEnrollment so enrollment progresses past the dead step", async () => {
      // Act
      await handleSendSequenceFlow(makeData(), makeJob())

      // Assert
      expect(advanceEnrollmentSpy).toHaveBeenCalledTimes(1)
    })

    test("removes dispatch from schedule", async () => {
      // Act
      await handleSendSequenceFlow(makeData(), makeJob())

      // Assert
      expect(removeFromScheduleSpy).toHaveBeenCalledWith(42, "dispatch-1")
    })

    test("does NOT call sendFlowDirect", async () => {
      // Act
      await handleSendSequenceFlow(makeData(), makeJob())

      // Assert
      expect(sendFlowDirectSpy).not.toHaveBeenCalled()
    })
  })

  describe("step not found in db", () => {
    beforeEach(() => {
      fetchStepSpy.mockResolvedValue(undefined)
      validateStepSpy.mockReturnValue({
        valid: false,
        reason: "step_not_found",
      })
    })

    test("marks dispatch canceled", async () => {
      // Act
      await handleSendSequenceFlow(makeData(), makeJob())

      // Assert
      expect(markCanceledSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          dispatchId: "dispatch-1",
          workspaceId: "ws-1",
          reason: "step_not_found",
        }),
      )
    })

    test("does NOT call advanceEnrollment — no step to advance past", async () => {
      // Act
      await handleSendSequenceFlow(makeData(), makeJob())

      // Assert
      expect(advanceEnrollmentSpy).not.toHaveBeenCalled()
    })

    test("still removes dispatch from schedule", async () => {
      // Act
      await handleSendSequenceFlow(makeData(), makeJob())

      // Assert
      expect(removeFromScheduleSpy).toHaveBeenCalledWith(42, "dispatch-1")
    })
  })

  describe("sendFlowDirect throws on final attempt", () => {
    beforeEach(() => {
      sendFlowDirectSpy.mockRejectedValue(new Error("send failed"))
    })

    test("marks dispatch failed via terminal cleanup", async () => {
      // Arrange — final attempt
      const job = makeJob({ attemptsMade: 2, attempts: 3 })

      // Act
      await expect(handleSendSequenceFlow(makeData(), job)).rejects.toThrow(
        "send failed",
      )

      // Assert
      expect(markFailedSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          dispatchId: "dispatch-1",
          workspaceId: "ws-1",
          errorMessage: "send failed",
        }),
      )
    })

    test("removes dispatch from schedule during terminal cleanup", async () => {
      // Arrange
      const job = makeJob({ attemptsMade: 2, attempts: 3 })

      // Act
      await expect(handleSendSequenceFlow(makeData(), job)).rejects.toThrow()

      // Assert
      expect(removeFromScheduleSpy).toHaveBeenCalledWith(42, "dispatch-1")
    })

    test("rethrows the error so BullMQ can retry", async () => {
      // Arrange
      const job = makeJob({ attemptsMade: 2, attempts: 3 })

      // Act + Assert
      await expect(handleSendSequenceFlow(makeData(), job)).rejects.toThrow(
        "send failed",
      )
    })
  })

  describe("sendFlowDirect throws on non-final attempt", () => {
    beforeEach(() => {
      sendFlowDirectSpy.mockRejectedValue(new Error("transient error"))
    })

    test("rethrows without marking dispatch failed", async () => {
      // Arrange — first of three attempts
      const job = makeJob({ attemptsMade: 0, attempts: 3 })

      // Act
      await expect(handleSendSequenceFlow(makeData(), job)).rejects.toThrow(
        "transient error",
      )

      // Assert — no terminal cleanup
      expect(markFailedSpy).not.toHaveBeenCalled()
    })

    test("logs the error with attempt and isFinalAttempt info", async () => {
      // Arrange
      const job = makeJob({ attemptsMade: 0, attempts: 3 })

      // Act
      await expect(handleSendSequenceFlow(makeData(), job)).rejects.toThrow()

      // Assert
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          attempt: 1,
          isFinalAttempt: false,
          dispatchId: "dispatch-1",
        }),
        expect.any(String),
      )
    })
  })
})
