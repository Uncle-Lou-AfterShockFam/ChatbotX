import {
  contactCustomFieldService,
  customFieldService,
  tagService,
} from "@chatbotx.io/business"
import { customFieldResolutionKey } from "@chatbotx.io/utils/custom-field"
import type { TagAttachContactInbox } from "./contact"

/**
 * The async verdict of a "Text via bulktext" send. The line worker answers a
 * send request with a delivery status: `delivered` when the text left the
 * line, or `failed` whose `error` is a closed reason code in one of three
 * classes (bulktext `src/engine/failure-reason.mjs`, s172):
 *
 *   compliance  a claim-time gate refused the send (STOP/START, allowlist,
 *               pacing streak or quota, own line, reply gates)
 *               -> verdict `skip`, tag `bt-blocked`
 *   contact     the CONTACT DATA is wrong or unreachable (unknown number,
 *               carrier "not delivered", bad address, hard bounce, complaint)
 *               -> verdict `unreachable`, tag `bt-unreachable`: a flow asks
 *               the person for a working number / address
 *   line        OUR line failed or the operator canceled (browser gone,
 *               Messages automation, throttle, bad flow options...)
 *               -> verdict `error`, tag `bt-send-error`: never bother the
 *               person, retry elsewhere / alert the operator
 *
 * Flows cannot branch on a status, so the verdict is written onto the
 * contact as custom fields plus a tag: `bt_verdict`, `bt_reason`,
 * `bt_failed_at` (the instant, so a repeat failure still changes a field),
 * `bt_failed_inbox` (the hub inbox id of the LINE that failed, so a repair
 * flow knows whether to ask for a number or an address), `bt_failed_to` (the
 * identity the send went to, so the flow can quote the number or address that
 * did not work) and the class tag.
 * Failure tags are attached with `emitFor: "all"` so the `tagApplied`
 * trigger fires on EVERY failure, including a repeat on a contact that
 * already carries the tag; `delivered` detaches all three.
 *
 * Any other non-empty `error` string is a line error too (skeptic s172): a
 * pull-mode refusal reason the daemon never classifies (`bad-options`,
 * `media-fetch`, `error`...) must alert the operator, never vanish. Only a
 * `failed` with no usable error text leaves the contact untouched.
 *
 * `bt-repair-asked` is set by the repair flow when it asks the person once;
 * `delivered` clears it with the failure tags so the next failure episode
 * may ask again, and a repeat failure inside one episode never re-asks.
 */
export const BULKTEXT_VERDICT_FIELD = "bt_verdict"
export const BULKTEXT_REASON_FIELD = "bt_reason"
export const BULKTEXT_FAILED_AT_FIELD = "bt_failed_at"
export const BULKTEXT_FAILED_INBOX_FIELD = "bt_failed_inbox"
export const BULKTEXT_FAILED_TO_FIELD = "bt_failed_to"
export const BULKTEXT_BLOCKED_TAG = "bt-blocked"
export const BULKTEXT_UNREACHABLE_TAG = "bt-unreachable"
export const BULKTEXT_SEND_ERROR_TAG = "bt-send-error"
export const BULKTEXT_REPAIR_ASKED_TAG = "bt-repair-asked"
export const BULKTEXT_FAILURE_TAGS: readonly string[] = [
  BULKTEXT_BLOCKED_TAG,
  BULKTEXT_UNREACHABLE_TAG,
  BULKTEXT_SEND_ERROR_TAG,
]

export const BULKTEXT_SKIP_REASONS: ReadonlySet<string> = new Set([
  "stop-reply",
  "opted-out",
  "suppressed",
  "not-allowlisted",
  "no-reply-streak",
  "new-contact-quota",
  "own-line",
  "replied",
  "not-replied",
])

export const BULKTEXT_UNREACHABLE_REASONS: ReadonlySet<string> = new Set([
  "bad-number",
  "bad-address",
  "undelivered",
  "bounce",
  "hard-bounce",
  "complaint",
])

export const BULKTEXT_LINE_ERROR_REASONS: ReadonlySet<string> = new Set([
  "line-error",
  "canceled",
])

export type BulktextVerdict = "send" | "skip" | "unreachable" | "error"

const TAG_FOR: Record<Exclude<BulktextVerdict, "send">, string> = {
  skip: BULKTEXT_BLOCKED_TAG,
  unreachable: BULKTEXT_UNREACHABLE_TAG,
  error: BULKTEXT_SEND_ERROR_TAG,
}

/**
 * Whether an API-channel integration row is a bulktext line worker: its
 * callback points at bulktext's hook route, or (pull mode, no callback) it
 * is named `bulktext-<line>`. Any other API-channel integration on the same
 * hub must never get bt_* fields written from its statuses (skeptic s163).
 */
export const isBulktextLine = (integrationRow: unknown): boolean => {
  const row = integrationRow as { callbackUrl?: unknown; name?: unknown } | null
  const callbackUrl =
    typeof row?.callbackUrl === "string" ? row.callbackUrl : ""
  const name = typeof row?.name === "string" ? row.name : ""
  return (
    callbackUrl.includes("/api/hooks/chatbotx") || name.startsWith("bulktext")
  )
}

export const bulktextVerdictFor = (
  status: string,
  error: unknown,
): { verdict: BulktextVerdict; reason: string } | null => {
  if (status === "delivered") {
    return { verdict: "send", reason: "" }
  }
  if (status !== "failed" || typeof error !== "string") {
    return null
  }
  if (BULKTEXT_SKIP_REASONS.has(error)) {
    return { verdict: "skip", reason: error }
  }
  if (BULKTEXT_UNREACHABLE_REASONS.has(error)) {
    return { verdict: "unreachable", reason: error }
  }
  if (error.trim() === "") {
    return null
  }
  return { verdict: "error", reason: error.slice(0, 120) }
}

const failedAtFor = (verdict: BulktextVerdict, timestamp: unknown): string => {
  if (verdict === "send") {
    return ""
  }
  if (typeof timestamp === "string" && !Number.isNaN(Date.parse(timestamp))) {
    return new Date(timestamp).toISOString()
  }
  return new Date().toISOString()
}

export async function applyBulktextVerdict(props: {
  workspaceId: string
  contactId: string
  contactInbox: TagAttachContactInbox
  status: string
  error: unknown
  /** When the status happened (the worker's `timestamp`); defaults to now. */
  timestamp?: unknown
  /** The channel identity the send went to (`ContactInbox.sourceId`). */
  failedTo?: unknown
}): Promise<BulktextVerdict | null> {
  const { workspaceId, contactId, contactInbox, status, error } = props
  const outcome = bulktextVerdictFor(status, error)
  if (!outcome) {
    return null
  }

  const fields = [
    { name: BULKTEXT_VERDICT_FIELD, type: "shortText" as const },
    { name: BULKTEXT_REASON_FIELD, type: "shortText" as const },
    { name: BULKTEXT_FAILED_AT_FIELD, type: "shortText" as const },
    { name: BULKTEXT_FAILED_INBOX_FIELD, type: "shortText" as const },
    { name: BULKTEXT_FAILED_TO_FIELD, type: "shortText" as const },
  ]
  const { idMap } = await customFieldService.resolveByNameAndType({
    workspaceId,
    fields,
  })
  const writes: [(typeof fields)[number], string][] = [
    [fields[0], outcome.verdict],
    [fields[1], outcome.reason],
    [fields[2], failedAtFor(outcome.verdict, props.timestamp)],
    [fields[3], outcome.verdict === "send" ? "" : contactInbox.inboxId],
    [
      fields[4],
      outcome.verdict === "send" || typeof props.failedTo !== "string"
        ? ""
        : props.failedTo.slice(0, 200),
    ],
  ]
  for (const [field, value] of writes) {
    const keyword = idMap.get(customFieldResolutionKey(field)) ?? field.name
    await contactCustomFieldService.setValueByKey({
      workspaceId,
      contactId,
      keyword,
      value,
      contactInboxId: contactInbox.id,
    })
  }

  if (outcome.verdict === "send") {
    await tagService.detachByNamesFromContacts({
      workspaceId,
      contactIds: [contactId],
      names: [...BULKTEXT_FAILURE_TAGS, BULKTEXT_REPAIR_ASKED_TAG],
    })
    return outcome.verdict
  }
  const tag = TAG_FOR[outcome.verdict]
  // The other two classes come off first: one send has ONE class, and a
  // flow branching on "unreachable" must not also see a stale "blocked".
  await tagService.detachByNamesFromContacts({
    workspaceId,
    contactIds: [contactId],
    names: BULKTEXT_FAILURE_TAGS.filter((name) => name !== tag),
  })
  await tagService.attachByNamesToContacts({
    workspaceId,
    contactIds: [contactId],
    names: [tag],
    contactInbox,
    // Every failure fires `tagApplied`, a repeat included: the repair flow
    // that PATCHed a new number and retried must hear about a second miss.
    emitFor: "all",
  })
  return outcome.verdict
}
