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
 * line, or `failed` whose `error` names the claim-time gate that stopped it
 * (STOP/START, allowlist, pacing streak or quota, a bounced address...).
 * Flows cannot branch on a status, so the verdict is written onto the
 * contact as two custom fields plus a tag, the same shape the earlier
 * `callApi` flows mapped by hand (`bt_verdict`, `bt_reason`, `bt-blocked`).
 *
 * Closed reason set: an unknown `error` is a provider failure, not a
 * verdict, and leaves the contact untouched.
 */
export const BULKTEXT_VERDICT_FIELD = "bt_verdict"
export const BULKTEXT_REASON_FIELD = "bt_reason"
export const BULKTEXT_BLOCKED_TAG = "bt-blocked"

export const BULKTEXT_SKIP_REASONS: ReadonlySet<string> = new Set([
  "stop-reply",
  "opted-out",
  "suppressed",
  "not-allowlisted",
  "no-reply-streak",
  "new-contact-quota",
  "own-line",
  "bounce",
  "hard_bounce",
  "complaint",
])

export type BulktextVerdict = "send" | "skip"

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
  if (
    status === "failed" &&
    typeof error === "string" &&
    BULKTEXT_SKIP_REASONS.has(error)
  ) {
    return { verdict: "skip", reason: error }
  }
  return null
}

export async function applyBulktextVerdict(props: {
  workspaceId: string
  contactId: string
  contactInbox: TagAttachContactInbox
  status: string
  error: unknown
}): Promise<BulktextVerdict | null> {
  const { workspaceId, contactId, contactInbox, status, error } = props
  const outcome = bulktextVerdictFor(status, error)
  if (!outcome) {
    return null
  }

  const fields = [
    { name: BULKTEXT_VERDICT_FIELD, type: "shortText" as const },
    { name: BULKTEXT_REASON_FIELD, type: "shortText" as const },
  ]
  const { idMap } = await customFieldService.resolveByNameAndType({
    workspaceId,
    fields,
  })
  const writes: [(typeof fields)[number], string][] = [
    [fields[0], outcome.verdict],
    [fields[1], outcome.reason],
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

  if (outcome.verdict === "skip") {
    await tagService.attachByNamesToContacts({
      workspaceId,
      contactIds: [contactId],
      names: [BULKTEXT_BLOCKED_TAG],
      contactInbox,
      emitFor: "newlyLinked",
    })
  } else {
    await tagService.detachByNamesFromContacts({
      workspaceId,
      contactIds: [contactId],
      names: [BULKTEXT_BLOCKED_TAG],
    })
  }
  return outcome.verdict
}
