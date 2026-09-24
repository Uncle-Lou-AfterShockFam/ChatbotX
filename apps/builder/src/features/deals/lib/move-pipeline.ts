import {
  type DealFieldDef,
  validateDealFields,
} from "@chatbotx.io/database/partials"

type Option = { label: string; value: string }

/**
 * The destination fieldDefs the deal's CURRENT fields do not satisfy (a
 * required key missing or null, or a stored value of the wrong type): the
 * same `requireAll` check `dealService.movePipeline` runs, so the dialog asks
 * for exactly what the server would refuse.
 */
export function fieldsNeedingInput(
  defs: readonly DealFieldDef[],
  fields: Record<string, unknown>,
): DealFieldDef[] {
  const keys = new Set(
    validateDealFields({ defs, fields, requireAll: true }).map((i) => i.key),
  )
  return defs.filter((def) => keys.has(def.key))
}

/**
 * Owner choices for the destination: a members-only pipeline offers its
 * members (plus the current owner, so the field can show who it is today;
 * the server says whether they may stay), any other pipeline every workspace
 * member.
 */
export function movePipelineOwnerOptions(props: {
  access: "workspace" | "members"
  memberIds: readonly string[]
  ownerOptions: readonly Option[]
  currentOwnerId: string | null
}): Option[] {
  const { access, memberIds, ownerOptions, currentOwnerId } = props
  if (access !== "members") {
    return [...ownerOptions]
  }
  const keep = new Set(memberIds)
  if (currentOwnerId) {
    keep.add(currentOwnerId)
  }
  return ownerOptions.filter((o) => keep.has(o.value))
}

/**
 * The action input: `ownerId` only when it changed (undefined = keep, "" =
 * clear -> null), `fields` only when the dialog collected some, the stage
 * only when one was picked (else the destination's first stage).
 */
export function buildMovePipelineInput(props: {
  id: string
  pipelineId: string
  stageId: string
  ownerId: string
  currentOwnerId: string | null
  fields: Record<string, unknown>
}): {
  id: string
  pipelineId: string
  stageId: string | null
  ownerId?: string | null
  fields?: Record<string, unknown>
} {
  const { id, pipelineId, stageId, ownerId, currentOwnerId, fields } = props
  return {
    id,
    pipelineId,
    stageId: stageId || null,
    ...(ownerId === (currentOwnerId ?? "") ? {} : { ownerId: ownerId || null }),
    ...(Object.keys(fields).length > 0 ? { fields } : {}),
  }
}
