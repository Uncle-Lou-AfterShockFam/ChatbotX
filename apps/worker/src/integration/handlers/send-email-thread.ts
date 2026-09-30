import { createHash, randomBytes } from "node:crypto"
import {
  EmailSenderUnavailableError,
  emailSenderService,
} from "@chatbotx.io/business/email-sender"
import {
  emailThreadMailService,
  isCitableMsgId,
  type ThreadScope,
} from "@chatbotx.io/business/email-thread"
import type { DatabaseClient } from "@chatbotx.io/database/client"
import type { EmailThreadMailModel } from "@chatbotx.io/database/types"
import {
  BROADCAST_PAYLOAD_TYPE,
  type EmailStepSchema,
  type MetadataPayload,
  SEQUENCE_SCHEDULE_PAYLOAD_TYPE,
} from "@chatbotx.io/flow-config"
import { EmailContentError } from "./send-email-document"
import { LINE_EMAIL_LIMITS } from "./send-email-line"

/**
 * Outreach B-1 (s225b, s226b): every line mail gets a hub-minted Message-ID
 * local part (the line appends its From domain, bulktext
 * `documentThreadHeaders`) and is recorded as an EmailThreadMail, so a later
 * step can reply under it, or under the contact's own mail. The line
 * validates keys with this same shape.
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

/**
 * The broadcast a send belongs to, or undefined. Job metadata is not
 * runtime-validated: only a real id scopes a thread (or the render cache).
 */
export function broadcastIdOf(
  metadata: MetadataPayload | undefined,
): string | undefined {
  if (metadata?.type !== BROADCAST_PAYLOAD_TYPE) {
    return
  }
  const id = (metadata as { broadcastId?: unknown }).broadcastId
  const value =
    typeof id === "string" || typeof id === "number" ? String(id) : ""
  return BIGINT_ID.test(value) ? value : undefined
}

export type ThreadMode = "previous" | "campaign" | "latest" | "none"

/** Where a line mail came from: what `previous` and `campaign` look up. */
export type ThreadSource = {
  sequenceId?: string
  broadcastId?: string
  flowId?: string
}

/**
 * The step's thread mode. Unset keeps s225b's behaviour: a TEXT step in a
 * sequence replies under that sequence's previous mail, anything else starts
 * its own thread.
 */
export function threadModeOf(
  step: Pick<EmailStepSchema, "threadMode">,
  format: "html" | "text",
  source: ThreadSource,
): ThreadMode {
  if (step.threadMode) {
    return step.threadMode
  }
  return format === "text" && source.sequenceId ? "previous" : "none"
}

export type ThreadPlan = {
  messageKey: string
  /** Earlier HUB mails' keys, oldest first. */
  threadKeys: string[]
  /**
   * Earlier FOREIGN msg-ids (the contact's own mail and what it cited),
   * oldest first; the line writes them before the keys in References.
   */
  replyTo: string[]
  /** The subject to send: the step's own, or `Re: <parent subject>`. */
  subject: string
  /**
   * s229b: the mailbox (EmailSender id) the mail goes out from, sticky per
   * thread; null = the line's legacy env account (`LineEmail.sender` absent).
   */
  senderId: string | null
}

const isForeign = (parent: string) => parent.startsWith("<")

/**
 * What a reply under `parent` cites, OLDEST FIRST in one list: the parent's
 * own parents, then the parent itself (a hub key bare, a foreign id in
 * brackets). Past LINE_EMAIL_LIMITS.threadKeys the oldest MIDDLE ids drop,
 * keeping the true root and the newest (skeptic s226b: trimmed as one
 * chronological list, so a mixed two-way thread never loses its root).
 */
export function citeParent(
  parent: Pick<
    EmailThreadMailModel,
    "direction" | "messageKey" | "messageId" | "parents"
  >,
): string[] {
  const own =
    parent.direction === "incoming" ? parent.messageId : parent.messageKey
  const chain = [...parent.parents, own ?? ""]
  const valid = chain.every((id) =>
    isForeign(id) ? isCitableMsgId(id) : MESSAGE_KEY.test(id),
  )
  if (!valid || new Set(chain).size !== chain.length) {
    throw new EmailContentError(
      "the email thread to reply under holds an invalid message id",
    )
  }
  while (chain.length > LINE_EMAIL_LIMITS.threadKeys) {
    chain.splice(1, 1)
  }
  return chain
}

type PlanProps = {
  workspaceId: string
  contactId: string
  lineInboxId: string
  subject: string
  source: ThreadSource
  mode: ThreadMode
  threadCampaign?: EmailStepSchema["threadCampaign"]
  /** `stop`: no earlier mail in scope sends nothing (null). */
  onNoThread: "new" | "stop"
  /** Stable across job retries (sequence dispatch + step, or broadcast + step). */
  sendId?: string
}

function scopeOf(props: PlanProps): ThreadScope | undefined {
  switch (props.mode) {
    case "previous":
      if (props.source.sequenceId) {
        return { sequenceId: props.source.sequenceId }
      }
      if (props.source.broadcastId) {
        return { broadcastId: props.source.broadcastId }
      }
      return props.source.flowId ? { flowId: props.source.flowId } : undefined
    case "campaign": {
      const campaign = props.threadCampaign
      if (campaign && "sequenceId" in campaign) {
        return { sequenceId: campaign.sequenceId }
      }
      if (campaign && "broadcastId" in campaign) {
        return { broadcastId: campaign.broadcastId }
      }
      throw new EmailContentError(
        "the email step replies under an earlier campaign but names none",
      )
    }
    case "latest":
      return {}
    default:
      return
  }
}

/**
 * Plans this mail's place in a thread and RECORDS it (before the send, so a
 * later step already sees it; a mail that then never queues stays recorded:
 * its retry derives the same key and replays it). Threads are per LINE: a
 * mail from another line is never a parent (its keys resolve on that line's
 * domain), so a step whose line changed starts afresh (owner decision (b),
 * s226b) instead of failing. A retried job gets the headers its first
 * attempt had. Null = `onNoThread: stop` and nothing in scope: send nothing.
 */
export function planThread(props: PlanProps): Promise<ThreadPlan | null> {
  const line = {
    workspaceId: props.workspaceId,
    contactId: props.contactId,
    lineInboxId: props.lineInboxId,
  }
  // Serialized per (contact, line): the parent lookup and this mail's record
  // are one step, so concurrent sends chain instead of both rooting.
  return emailThreadMailService.withLineLock(line, (tx) =>
    planLocked(props, line, tx),
  )
}

async function planLocked(
  props: PlanProps,
  line: { workspaceId: string; contactId: string; lineInboxId: string },
  tx: DatabaseClient,
): Promise<ThreadPlan | null> {
  const messageKey = mintMessageKey(
    props.sendId && `${props.workspaceId}:${props.contactId}:${props.sendId}`,
  )
  const replay = await emailThreadMailService.findByKey({
    ...line,
    messageKey,
    tx,
  })
  if (replay) {
    // Review s229b: a replay re-checks its recorded sender (an archived one
    // fails closed), and never picks another.
    await threadSenderOf(replay, line, tx)
    return planOf(messageKey, replay)
  }
  const scope = scopeOf(props)
  const parent = scope
    ? await emailThreadMailService.latest({ ...line, scope, tx })
    : null
  if (!parent && scope && props.onNoThread === "stop") {
    return null
  }
  const parents = parent ? citeParent(parent) : []
  const subject =
    parent && parent.subject.trim() !== ""
      ? replySubject(parent.subject)
      : props.subject
  const senderId = await threadSenderOf(parent, line, tx)
  const recorded = await emailThreadMailService.recordOutgoing({
    ...line,
    ...props.source,
    messageKey,
    subject,
    parents,
    senderId,
    tx,
  })
  if (!recorded) {
    // Under the lock only a key recorded outside it (a deleted-and-reused
    // contact line) can collide: transient, the job's retry re-plans.
    throw new Error("email thread mail changed while planning")
  }
  return planOf(messageKey, recorded)
}

/**
 * s229b (wire contract sec. 4): a follow-up NEVER switches mailbox. A parent
 * keeps its sender (a null one is a legacy env-account thread and stays
 * null); an archived parent sender fails closed. A new thread takes the
 * line's least-used active sender today, or null when the line has none.
 */
async function threadSenderOf(
  /** The parent, or the replayed row itself (its own sender is sticky). */
  parent: Pick<EmailThreadMailModel, "senderId"> | null,
  line: { workspaceId: string; lineInboxId: string },
  tx: DatabaseClient,
): Promise<string | null> {
  try {
    if (parent) {
      if (parent.senderId) {
        await emailSenderService.assertThreadSender(tx, {
          workspaceId: line.workspaceId,
          lineInboxId: line.lineInboxId,
          senderId: parent.senderId,
        })
      }
      return parent.senderId ?? null
    }
    return await emailSenderService.pickForNewThread(tx, {
      workspaceId: line.workspaceId,
      lineInboxId: line.lineInboxId,
    })
  } catch (err) {
    if (err instanceof EmailSenderUnavailableError) {
      throw new EmailContentError(err.message)
    }
    throw err
  }
}

function planOf(
  messageKey: string,
  row: Pick<EmailThreadMailModel, "subject" | "parents" | "senderId">,
): ThreadPlan {
  return {
    messageKey,
    threadKeys: row.parents.filter((id) => !isForeign(id)),
    replyTo: row.parents.filter(isForeign),
    subject: row.subject,
    senderId: row.senderId ?? null,
  }
}
