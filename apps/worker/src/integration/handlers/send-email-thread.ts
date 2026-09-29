import { randomBytes } from "node:crypto"
import { emailThreadService } from "@chatbotx.io/business/email-thread"
import {
  type MetadataPayload,
  SEQUENCE_SCHEDULE_PAYLOAD_TYPE,
} from "@chatbotx.io/flow-config"
import { EmailContentError } from "./send-email-document"

/**
 * Outreach B-1 (s225b): a sequence's plain-text steps read as ONE email
 * conversation. The hub mints each mail's Message-ID local part; the line
 * appends its From domain (bulktext `documentThreadHeaders`), so the hub
 * never needs the RFC id back. The line validates keys with this same shape.
 */
export const MESSAGE_KEY = /^[A-Za-z0-9_-][A-Za-z0-9._-]{6,62}[A-Za-z0-9_-]$/
const BIGINT_ID = /^\d{1,19}$/
const REPLY_PREFIX = /^re:\s/i

/** A fresh Message-ID local part: `bt.` + 120 random bits (base64url). */
export function mintMessageKey(): string {
  return `bt.${randomBytes(15).toString("base64url")}`
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

/** `Re: <subject>`, never `Re: Re:`. */
export function replySubject(subject: string): string {
  const s = subject.trim()
  return REPLY_PREFIX.test(s) ? s : `Re: ${s}`
}

export type ThreadPlan = {
  messageKey: string
  /** Earlier mails' keys, root first; empty for the thread's first mail. */
  threadKeys: string[]
  /** The subject to send: the step's own, or `Re: <first subject>`. */
  subject: string
}

/**
 * Plans this mail's place in the contact's sequence thread. A thread started
 * on ANOTHER line fails closed (its keys only resolve on that line's domain,
 * so a reply there would thread nowhere): unusable content, no send. A stored
 * key that is not a hub key also fails closed rather than reach the line.
 */
export async function planThread(props: {
  workspaceId: string
  contactId: string
  sequenceId: string
  lineInboxId: string
  subject: string
}): Promise<ThreadPlan> {
  const thread = await emailThreadService.find(props)
  const messageKey = mintMessageKey()
  if (!thread || thread.keys.length === 0) {
    return { messageKey, threadKeys: [], subject: props.subject }
  }
  if (thread.lineInboxId !== props.lineInboxId) {
    throw new EmailContentError(
      `sequence ${props.sequenceId} mailed this contact from line ${thread.lineInboxId}; a follow-up from line ${props.lineInboxId} cannot join that thread`,
    )
  }
  if (!thread.keys.every((k) => MESSAGE_KEY.test(k))) {
    throw new EmailContentError(
      `email thread ${thread.id} holds an invalid key`,
    )
  }
  return {
    messageKey,
    threadKeys: thread.keys,
    subject: replySubject(thread.subject),
  }
}
