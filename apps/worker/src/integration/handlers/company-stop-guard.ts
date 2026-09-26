import { logger } from "../../lib/logger"
import { wasCompanyStoppedSince } from "./smart-delay"

/**
 * What runStepsAndQuickReplies / runFlowNode / sendFlowDirect return when the
 * run ended on a company stop, so a caller that keeps bookkeeping (a sequence
 * dispatch, a pending challenge) can close it instead of recording a send.
 */
export const COMPANY_STOPPED = "companyStopped" as const

/**
 * The contact's company was stopped after the run began: the run ends before
 * its next step. Caught by runStepsAndQuickReplies, so it never reaches a job
 * (no retry, no broadcast failure, no error log).
 */
export class CompanyStoppedError extends Error {
  readonly contactInboxId: string
  readonly runStartedAt: Date

  constructor(contactInboxId: string, runStartedAt: Date) {
    super(
      `Company of contactInbox ${contactInboxId} was stopped after the run started at ${runStartedAt.toISOString()}`,
    )
    this.name = "CompanyStoppedError"
    this.contactInboxId = contactInboxId
    this.runStartedAt = runStartedAt
  }
}

/**
 * Throws CompanyStoppedError when the contact's company was stopped after
 * `runStartedAt`. A run that began after the stop (the `company-stopped` tag
 * trigger) passes; no run start = no check (the resume re-check still applies).
 * A failed lookup is logged and the step runs: every wait resume re-checks.
 */
export async function assertCompanyNotStoppedSince(props: {
  workspaceId: string
  contactInboxId: string
  runStartedAt: Date | undefined
}): Promise<void> {
  const { workspaceId, contactInboxId, runStartedAt } = props
  if (!runStartedAt) {
    return
  }
  let stopped: boolean
  try {
    stopped = await wasCompanyStoppedSince(
      { workspaceId, contactInboxId },
      runStartedAt,
    )
  } catch (err) {
    logger.warn(
      { err, contactInboxId },
      "Stopped-company step check failed; the step runs",
    )
    return
  }
  if (stopped) {
    throw new CompanyStoppedError(contactInboxId, runStartedAt)
  }
}

/**
 * The start of the run a job belongs to: the run start its job data carries
 * (ISO string, set by the pass that enqueued it) or, for a job that opens a
 * run, its own enqueue time. The earlier of the two wins, so a malformed or
 * future carried value never makes a run look younger than its job.
 */
export function resolveRunStartedAt(
  carried: string | Date | undefined,
  jobTimestamp: number,
): Date {
  const parsed = carried ? new Date(carried).getTime() : Number.NaN
  return new Date(
    Number.isNaN(parsed) ? jobTimestamp : Math.min(parsed, jobTimestamp),
  )
}
