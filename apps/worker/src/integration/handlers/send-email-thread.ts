import { createHash, randomBytes } from "node:crypto"
import { emailThreadService } from "@chatbotx.io/business/email-thread"
import {
  type MetadataPayload,
  SEQUENCE_SCHEDULE_PAYLOAD_TYPE,
} from "@chatbotx.io/flow-config"
import { EmailContentError } from "./send-email-document"
import { LINE_EMAIL_LIMITS } from "./send-email-line"

/**
 * Outreach B-1 (s225b): a sequence's plain-text steps read as ONE email
 * conversation. The hub mints each mail's Message-ID local part; the line
 * appends its From domain (bulktext `documentThreadHeaders`), so the hub
 * never needs the RFC id back. The line validates keys with this same shape.
 */
export const MESSAGE_KEY = /^[A-Za-z0-9_-][A-Za-z0-9._-]{6,62}[A-Za-z0-9_-]$/
const BIGINT_ID = /^\d{1,19}$/
const DISPATCH_ID = /^[A-Za-z0-9_-]{1,64}$/
const REPLY_PREFIX = /^re:\s/i

/**
 * A Message-ID local part: `bt.` + 120 bits (base64url). With a `sendId`
 * (workspace, contact, sequence, dispatch, step) it is DERIVED, so a retried
 * job reuses the same key (skeptic s225b): the line refuses a key another
 * row already sent, and the thread sees the replay instead of a new mail.
 * Random without one.
 */
export function mintMessageKey(sendId?: string): string {
  const bits = sendId
    ? createHash("sha256")
        .update(`bt-thread\u0000${sendId}`)
        .digest()
        .subarray(0, 15)
    : randomBytes(15)
  return `bt.${bits.toString("base64url")}`
}

/**
 * The sequence a send belongs to, or undefined. Job metadata is not
 * runtime-validated, and the producer can send an empty id: only a real one
 * scopes a thread.
 */
export function sequenceIdOf(
  metadata: MetadataPayload | undefined,
): string | undefined {
  if (metadata?.type !== SEQUENCE_SCHEDULE_PAYLOAD_TYPE) {
    return
  }
  const id = (metadata as { sequenceId?: unknown }).sequenceId
  return typeof id === "string" && BIGINT_ID.test(id) ? id : undefined
}

/**
 * One sequence step's send identity (dispatch + step), stable across job
 * retries, or undefined when the metadata carries no usable dispatch id.
 */
export function sequenceSendIdOf(
  metadata: MetadataPayload | undefined,
  stepId: string,
): string | undefined {
  if (metadata?.type !== SEQUENCE_SCHEDULE_PAYLOAD_TYPE) {
    return
  }
  const dispatchId = (metadata as { dispatchId?: unknown }).dispatchId
  return typeof dispatchId === "string" && DISPATCH_ID.test(dispatchId)
    ? `${dispatchId}:${stepId}`
    : undefined
}

/**
 * `Re: <subject>`, never `Re: Re:`, cut to fit the line's subject cap (Codex
 * s225b: a 197..200-char first subject must not fail every follow-up).
 */
export function replySubject(subject: string): string {
  const s = subject.trim()
  const reply = REPLY_PREFIX.test(s) ? s : `Re: ${s}`
  return reply.length > LINE_EMAIL_LIMITS.subject
    ? reply.slice(0, LINE_EMAIL_LIMITS.subject).trimEnd()
    : reply
}

export type ThreadPlan = {
  messageKey: string
  /** Earlier mails' keys, root first; empty for the thread's first mail. */
  threadKeys: string[]
  /** The subject to send: the step's own, or `Re: <first subject>`. */
  subject: string
  /**
   * True when this mail CLAIMED the thread's root (its key is already
   * stored, so it is not recorded again). A root whose mail never queues is
   * kept, never released (Codex s225b: a release races retries and
   * follow-ups): its retry derives the same key and replays it, and a later
   * step still threads, under a phantom In-Reply-To.
   */
  root: boolean
}

type ThreadRef = {
  workspaceId: string
  contactId: string
  sequenceId: string
  lineInboxId: string
  subject: string
}

/**
 * Plans this mail's place in the contact's sequence thread. The first mail
 * CLAIMS the root atomically, so concurrent first sends never start two
 * threads (the loser follows up). A thread started on ANOTHER line fails
 * closed (its keys only resolve on that line's domain, so a reply there
 * would thread nowhere): unusable content, no send. A stored key that is not
 * a hub key also fails closed rather than reach the line. A retried job
 * (same `sendId`, so the same key) gets the headers its first attempt had.
 */
export async function planThread(
  props: ThreadRef & { sendId?: string },
): Promise<ThreadPlan> {
  const { sendId, ...ref } = props
  const messageKey = mintMessageKey(
    sendId && `${ref.workspaceId}:${ref.contactId}:${ref.sequenceId}:${sendId}`,
  )
  let thread = await emailThreadService.find(ref)
  if (!thread) {
    const claimed = await emailThreadService.claimRoot({
      ...ref,
      key: messageKey,
    })
    if (claimed) {
      return { messageKey, threadKeys: [], subject: ref.subject, root: true }
    }
    thread = await emailThreadService.find(ref)
    if (!thread) {
      // Deleted between the claim and this read (its sequence or contact
      // was removed): transient, the job's retry re-plans.
      throw new Error(
        `email thread for sequence ${ref.sequenceId} changed while planning`,
      )
    }
  }
  if (thread.lineInboxId !== ref.lineInboxId) {
    throw new EmailContentError(
      `sequence ${ref.sequenceId} mailed this contact from line ${thread.lineInboxId}; a follow-up from line ${ref.lineInboxId} cannot join that thread`,
    )
  }
  if (
    thread.keys.length === 0 ||
    !thread.keys.every((k) => MESSAGE_KEY.test(k))
  ) {
    throw new EmailContentError(
      `email thread ${thread.id} holds an invalid key`,
    )
  }
  // A retried job: this very mail is already in the thread. Re-send it with
  // the headers it had; the line refuses it if the first attempt went out.
  // Concurrent follow-ups may have recorded in another order, so a replay's
  // ancestors can differ from the first attempt's: still one thread, and the
  // line sends only one row per key.
  const at = thread.keys.indexOf(messageKey)
  if (at >= 0) {
    return {
      messageKey,
      threadKeys: thread.keys.slice(0, at),
      subject: at === 0 ? thread.subject : replySubject(thread.subject),
      root: false,
    }
  }
  return {
    messageKey,
    threadKeys: thread.keys,
    subject: replySubject(thread.subject),
    root: false,
  }
}
