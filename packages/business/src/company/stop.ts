/**
 * The company stop cascade. Node-only (reaches `contact-sequence`, hence
 * sequence-scheduler's `crypto`), so it is exposed as the
 * `@chatbotx.io/business/company-stop` subpath and never from the barrel.
 *
 * Stopping a company: stamp the row (the `FOR UPDATE` row lock serialises
 * racing triggers so exactly one caller does the work), then for every
 * contact of the company remove sequence enrolments, cancel parked flow
 * waits, exclude it from still-sending broadcasts, and apply the
 * `company-stopped` tag. The tag's `tagApplied` event is what lets flows,
 * webhooks and `waitForEvent` react; no new trigger type exists.
 */

import { and, db, eq } from "@chatbotx.io/database/client"
import { COMPANY_STOPPED_TAG_NAME } from "@chatbotx.io/database/partials"
import { companyModel, contactModel } from "@chatbotx.io/database/schema"
import { buildJobId } from "@chatbotx.io/flow-config"
import { integrationQueue } from "@chatbotx.io/worker-config"
import { dispatchAuditRecordSafely } from "../audit/dispatcher"
import { broadcastService } from "../broadcast/service"
import { contactSequenceService } from "../contact-sequence/service"
import { logger } from "../logger"
import { smartDelayService } from "../smart-delay/service"
import { tagService } from "../tag/service"
import { companyService } from "./service"

export type CompanyStopReason =
  | "contact_replied"
  | "tag_applied"
  | "api"
  | "deal"

export type CompanyStopResult =
  | {
      status: "stopped"
      companyId: string
      contactCount: number
      enrollmentsRemoved: number
      smartDelaysCanceled: number
      broadcastRowsFailed: number
      tagId?: string
    }
  | { status: "already_stopped"; companyId: string }
  | { status: "skipped"; companyId: string; why: "stopOnReply_off" }

export type CompanyStopForContactResult =
  | CompanyStopResult
  | { status: "no_company"; contactId: string }

/** Reasons that stop a company even when its `stopOnReply` opt-out is off. */
const FORCED_REASONS: ReadonlySet<CompanyStopReason> = new Set(["api", "deal"])

const SMART_DELAY_CANCEL_BATCH = 500
const MAX_SMART_DELAY_BATCHES = 200

export const COMPANY_STOPPED_BROADCAST_REASON = "company-stopped"

type ClaimOutcome =
  | { kind: "claimed"; stopOnReply: boolean }
  | { kind: "already_stopped" }
  | { kind: "skipped" }

/**
 * Phase 1, inside one transaction: lock the company row, decide, stamp.
 * Returning `claimed` means this caller owns the cascade.
 */
async function claimCompanyStop(props: {
  workspaceId: string
  companyId: string
  reason: CompanyStopReason
  triggeredByContactId?: string
  force: boolean
}): Promise<ClaimOutcome> {
  return await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: companyModel.id,
        stoppedAt: companyModel.stoppedAt,
        stopOnReply: companyModel.stopOnReply,
      })
      .from(companyModel)
      .where(
        and(
          eq(companyModel.id, props.companyId),
          eq(companyModel.workspaceId, props.workspaceId),
        ),
      )
      .for("update")
    if (!row) {
      throw new Error(`Company ${props.companyId} not found`)
    }
    if (row.stoppedAt) {
      return { kind: "already_stopped" }
    }
    if (!(row.stopOnReply || props.force || FORCED_REASONS.has(props.reason))) {
      return { kind: "skipped" }
    }
    await tx
      .update(companyModel)
      .set({
        stoppedAt: new Date(),
        stopReason: props.reason,
        stoppedByContactId: props.triggeredByContactId ?? null,
      })
      .where(eq(companyModel.id, props.companyId))
    return { kind: "claimed", stopOnReply: row.stopOnReply }
  })
}

async function removeSequenceEnrollments(props: {
  workspaceId: string
  contactIds: string[]
}): Promise<number> {
  const sequenceIds = new Set<string>()
  for (const contactId of props.contactIds) {
    const enrollments = await contactSequenceService.listByContactId({
      workspaceId: props.workspaceId,
      contactId,
    })
    for (const enrollment of enrollments) {
      sequenceIds.add(enrollment.sequenceId)
    }
  }
  if (sequenceIds.size === 0) {
    return 0
  }
  const removed =
    await contactSequenceService.removeContactSequencesForContacts({
      workspaceId: props.workspaceId,
      contactIds: props.contactIds,
      sequenceIds: [...sequenceIds],
      reason: "company_stopped",
    })
  return removed.length
}

async function cancelSmartDelays(props: {
  workspaceId: string
  contactIds: string[]
}): Promise<number> {
  let canceled = 0
  for (let batch = 0; batch < MAX_SMART_DELAY_BATCHES; batch += 1) {
    const rows = await smartDelayService.cancelActiveForContacts({
      workspaceId: props.workspaceId,
      contactIds: props.contactIds,
      limit: SMART_DELAY_CANCEL_BATCH,
    })
    if (rows.length === 0) {
      break
    }
    canceled += rows.length
    // Best-effort: the rows are already canceled, so a surviving job is inert.
    const removals = await Promise.allSettled(
      rows.map((row) =>
        integrationQueue.remove(buildJobId(row.id, row.triggerAt)),
      ),
    )
    const failed = removals.filter((result) => result.status === "rejected")
    if (failed.length > 0) {
      logger.warn(
        { failedCount: failed.length, workspaceId: props.workspaceId },
        "company-stop: failed to remove smart-delay jobs",
      )
    }
    if (rows.length < SMART_DELAY_CANCEL_BATCH) {
      break
    }
  }
  return canceled
}

async function applyStoppedTag(props: {
  workspaceId: string
  contactIds: string[]
}): Promise<string | undefined> {
  const tagId = await tagService.ensureTagByName({
    workspaceId: props.workspaceId,
    name: COMPANY_STOPPED_TAG_NAME,
  })
  if (!tagId) {
    return
  }
  await tagService.bulkAttachToContacts({
    workspaceId: props.workspaceId,
    contactIds: props.contactIds,
    tagIds: [tagId],
  })
  return tagId
}

/**
 * Runs one cascade phase; a failure is logged and counted as zero so the
 * remaining phases still run (the company is already marked stopped, and the
 * API caller can re-run with `force` to redo the cascade).
 */
async function phase<T>(
  name: string,
  props: { workspaceId: string; companyId: string },
  run: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await run()
  } catch (error) {
    logger.warn(
      { error, phase: name, ...props },
      "company-stop: cascade phase failed",
    )
    return fallback
  }
}

export async function stopCompany(props: {
  workspaceId: string
  companyId: string
  reason: CompanyStopReason
  triggeredByContactId?: string
  /** Re-run the cascade on an already-stopped company (API repair). */
  force?: boolean
}): Promise<CompanyStopResult> {
  const { workspaceId, companyId, reason } = props
  const force = props.force ?? false

  const claim = await claimCompanyStop({
    workspaceId,
    companyId,
    reason,
    triggeredByContactId: props.triggeredByContactId,
    force,
  })
  if (claim.kind === "already_stopped" && !force) {
    return { status: "already_stopped", companyId }
  }
  if (claim.kind === "skipped") {
    return { status: "skipped", companyId, why: "stopOnReply_off" }
  }

  const contactIds = await companyService.listContactIds({
    workspaceId,
    companyId,
  })
  const ctx = { workspaceId, companyId }

  const enrollmentsRemoved = await phase(
    "sequences",
    ctx,
    () => removeSequenceEnrollments({ workspaceId, contactIds }),
    0,
  )
  const smartDelaysCanceled = await phase(
    "smart-delays",
    ctx,
    () => cancelSmartDelays({ workspaceId, contactIds }),
    0,
  )
  const broadcastRowsFailed = await phase(
    "broadcasts",
    ctx,
    () =>
      broadcastService.markContactsFailedForContacts({
        workspaceId,
        contactIds,
        reason: COMPANY_STOPPED_BROADCAST_REASON,
      }),
    0,
  )
  const tagId = await phase(
    "tag",
    ctx,
    () => applyStoppedTag({ workspaceId, contactIds }),
    undefined,
  )

  await dispatchAuditRecordSafely(
    {
      action: "company.stop",
      detail: `${companyId}:${reason}:${contactIds.length}`,
    },
    "company-stop: audit record failed",
  )
  logger.info(
    {
      ...ctx,
      reason,
      contactCount: contactIds.length,
      enrollmentsRemoved,
      smartDelaysCanceled,
      broadcastRowsFailed,
    },
    "company-stop: company stopped",
  )

  return {
    status: "stopped",
    companyId,
    contactCount: contactIds.length,
    enrollmentsRemoved,
    smartDelaysCanceled,
    broadcastRowsFailed,
    tagId,
  }
}

/** The contact's company, if any, is stopped with the contact as the trigger. */
export async function stopCompanyForContact(props: {
  workspaceId: string
  contactId: string
  reason: CompanyStopReason
}): Promise<CompanyStopForContactResult> {
  const { workspaceId, contactId, reason } = props
  const [contact] = await db
    .select({ companyId: contactModel.companyId })
    .from(contactModel)
    .where(
      and(
        eq(contactModel.id, contactId),
        eq(contactModel.workspaceId, workspaceId),
      ),
    )
    .limit(1)
  if (!contact?.companyId) {
    return { status: "no_company", contactId }
  }
  return await stopCompany({
    workspaceId,
    companyId: contact.companyId,
    reason,
    triggeredByContactId: contactId,
  })
}
