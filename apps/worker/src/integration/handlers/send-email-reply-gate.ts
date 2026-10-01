import { contactSequenceService } from "@chatbotx.io/business/contact-sequence"
import {
  type MetadataPayload,
  SEQUENCE_SCHEDULE_PAYLOAD_TYPE,
} from "@chatbotx.io/flow-config"

const MINUTE_MS = 60_000
const BIGINT_ID = /^\d{1,19}$/

/** The first whole minute strictly AFTER `at` (12:00:00.000 -> 12:01). */
export function nextWholeMinute(at: Date): Date {
  return new Date((Math.floor(at.getTime() / MINUTE_MS) + 1) * MINUTE_MS)
}

/**
 * s236: the `skipIfRepliedSince` instant of a stop-on-reply sequence's mail
 * relayed by an email LINE. The hub completes a dispatch as soon as the line
 * has the mail, but the line may HOLD it for hours (sender gap, daily cap):
 * a reply that ends the enrolment cannot recall mails already queued there.
 * The line skips the mail at claim time ('replied', a compliance reason)
 * when a WRITTEN reply (`replies.kind = 'text'`; out-of-office and auto
 * replies never make a row) from the address arrived at/after this instant,
 * truncated DOWN to its minute (bulktext runner.mjs).
 *
 * T = nextWholeMinute(max(enrolledAt, repliedAt)), repliedAt only while the
 * enrolment is not ended. Code facts it rests on:
 * - The reply end (removeStopOnReplyEnrollments) sets status 'ended',
 *   replyState 'replied', repliedAt = the reply message's hub createdAt; it
 *   leaves enrolledAt alone.
 * - A reactivation (reactivateEnrollment: operator API, re-subscribe, flow
 *   subscribe) never touches replyState / repliedAt. Resuming mid-sequence
 *   keeps enrolledAt, so enrolledAt < repliedAt and the floor must move past
 *   the reply the operator already chose to override; a restart of a
 *   finished contact sets enrolledAt = now(), later than that reply.
 * - repliedAt is the HUB's insert time of the relayed message, which the
 *   line writes before it relays, so the line's own row for that reply is
 *   at or before it; the next whole minute clears it even though the line
 *   truncates T down to its minute.
 * - An out-of-office (pauseForAutoReply) also stamps repliedAt, but only on
 *   an ACTIVE enrolment: any written reply before it already ended the
 *   cycle (and was overridden by a reactivation), so moving T past it hides
 *   nothing the stop rule acts on.
 * - enrolledAt is rounded UP too (the brief asked for it raw): the line
 *   truncates T down, so a raw enrolledAt would trip on the very reply that
 *   triggered the enrolment in the same minute (a keyword flow's subscribe
 *   step); the hub's own stop rule ignores replies before enrolledAt.
 * - An ENDED enrolment (a flow mail sent after its sequence step, e.g.
 *   behind a wait) keeps T at the cycle start: the reply that ended it must
 *   stop the mail, not be stepped over.
 * Residual: a written reply in the remainder of that rounding minute is not
 * gated by the line (the hub's stop rule still ends the enrolment).
 */
export function replyGateSince(cycle: {
  status: string | null
  enrolledAt: Date
  repliedAt: Date | null
}): Date {
  const floor =
    cycle.status !== "ended" &&
    cycle.repliedAt &&
    cycle.repliedAt > cycle.enrolledAt
      ? cycle.repliedAt
      : cycle.enrolledAt
  return nextWholeMinute(floor)
}

/**
 * The `skipIfRepliedSince` ISO for a sequence send, or undefined: not a
 * sequence send, no usable dispatch id, the dispatch / enrolment is gone, or
 * the sequence does not stop on reply. A read error propagates (the job
 * retries; nothing was written yet).
 */
export async function lineReplyGateOf(props: {
  workspaceId: string
  metadata: MetadataPayload | undefined
}): Promise<string | undefined> {
  const { metadata } = props
  if (metadata?.type !== SEQUENCE_SCHEDULE_PAYLOAD_TYPE) {
    return
  }
  const dispatchId = (metadata as { dispatchId?: unknown }).dispatchId
  if (!(typeof dispatchId === "string" && BIGINT_ID.test(dispatchId))) {
    return
  }
  const cycle = await contactSequenceService.findReplyGate({
    dispatchId,
    workspaceId: props.workspaceId,
  })
  if (!cycle?.stopOnReply) {
    return
  }
  return replyGateSince(cycle).toISOString()
}
