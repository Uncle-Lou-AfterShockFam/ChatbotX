/**
 * s228b (owner): an enrolment ended for one of these reasons is final - it is
 * never reactivated, by the API or by a re-subscribe.
 */
export const TERMINAL_END_REASONS: ReadonlySet<string> = new Set([
  "bounced",
  "unsubscribed",
])

/** A dispatch still to run or running: at most one per enrolment. */
export const LIVE_DISPATCH_STATUSES = ["pending", "running", "held"] as const
