import { and, type DatabaseClient, eq } from "@chatbotx.io/database/client"
import { workspaceMemberModel } from "@chatbotx.io/database/schema"
import type { DealModel } from "@chatbotx.io/database/types"
import type { DealEventMetadata } from "@chatbotx.io/events"
import { validationException } from "../errors"

/** The deal projection every deal / deal-task event carries. */
export function dealEventMetadata(deal: DealModel): DealEventMetadata {
  return {
    dealId: deal.id,
    pipelineId: deal.pipelineId,
    stageId: deal.stageId,
    title: deal.title,
    value: deal.value,
    currency: deal.currency,
    status: deal.status,
    priority: deal.priority,
    ownerId: deal.ownerId,
    companyId: deal.companyId,
  }
}

/** A `null` / "" clears; anything but a valid Date / ISO string is a 422 on `field`. */
export function parseDateOrNull(value: unknown, field = "dueAt"): Date | null {
  if (value === null || value === undefined || value === "") {
    return null
  }
  const date = value instanceof Date ? value : new Date(String(value))
  if (Number.isNaN(date.getTime())) {
    throw validationException(field, "Due date must be a valid date.")
  }
  return date
}

/** Required, trimmed, capped text; the 422 names `field`. */
export function parseRequiredText(props: {
  value: unknown
  field: string
  max: number
  label?: string
}): string {
  const label = props.label ?? "Title"
  const text = typeof props.value === "string" ? props.value.trim() : ""
  if (text.length === 0) {
    throw validationException(props.field, `${label} is required.`)
  }
  if (text.length > props.max) {
    throw validationException(
      props.field,
      `${label} is at most ${props.max} characters.`,
    )
  }
  return text
}

/** Optional text; null / "" -> null; non-string or over `max` is a 422. */
export function parseOptionalText(props: {
  value: unknown
  field: string
  max: number
  label?: string
}): string | null {
  const { value } = props
  if (value === null || value === undefined || value === "") {
    return null
  }
  if (typeof value !== "string") {
    throw validationException(
      props.field,
      `${props.label ?? "Description"} must be text.`,
    )
  }
  if (value.length > props.max) {
    throw validationException(
      props.field,
      `${props.label ?? "Description"} is at most ${props.max} characters.`,
    )
  }
  return value
}

/**
 * A user id that must belong to the workspace (deal owner, task assignee);
 * null / "" clears. The 422 names `field` and `role`.
 */
export async function resolveWorkspaceMember(props: {
  workspaceId: string
  userId: string | null | undefined
  tx: DatabaseClient
  field: string
  role: string
}): Promise<string | null> {
  const { userId } = props
  if (userId === undefined || userId === null || userId === "") {
    return null
  }
  const [member] = await props.tx
    .select({ userId: workspaceMemberModel.userId })
    .from(workspaceMemberModel)
    .where(
      and(
        eq(workspaceMemberModel.workspaceId, props.workspaceId),
        eq(workspaceMemberModel.userId, userId),
      ),
    )
    .limit(1)
  if (!member) {
    throw validationException(
      props.field,
      `${props.role} is not a member of this workspace.`,
    )
  }
  return member.userId
}
