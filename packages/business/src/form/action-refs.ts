import {
  and,
  type DatabaseClient,
  eq,
  inArray,
} from "@chatbotx.io/database/client"
import type { FormAction } from "@chatbotx.io/database/partials"
import {
  customFieldModel,
  workspaceMemberModel,
} from "@chatbotx.io/database/schema"
import { normalizeCustomFieldValueForStorage } from "../contact-custom-field/normalize"
import { validationException } from "../errors"

/**
 * Save-time check of a form's action catalogue (s220 A2-3): refuse actions
 * that point at a field or user this workspace does not have, a set-field
 * value the field would refuse at write time (it would fail every submit),
 * and points into a field the form itself writes (the submit's fill-blanks
 * would overwrite the running total). Kept apart from the runner so the form
 * service does not import the custom-field and tag services.
 */
export async function assertFormActionRefs(props: {
  tx: DatabaseClient
  workspaceId: string
  actions: FormAction[]
  /** Custom fields the form's own questions map to (draft and live). */
  mappedCustomFieldIds?: readonly string[]
}): Promise<void> {
  const { tx, workspaceId, actions } = props
  const mapped = new Set(props.mappedCustomFieldIds ?? [])
  const fieldIds = [
    ...new Set(
      actions.flatMap((a) =>
        a.type === "addPoints" || a.type === "setField"
          ? [a.customFieldId]
          : [],
      ),
    ),
  ]
  const fields = fieldIds.length
    ? await tx
        .select({
          id: customFieldModel.id,
          type: customFieldModel.type,
          options: customFieldModel.options,
        })
        .from(customFieldModel)
        .where(
          and(
            eq(customFieldModel.workspaceId, workspaceId),
            inArray(customFieldModel.id, fieldIds),
          ),
        )
    : []
  const typeOf = new Map(fields.map((f) => [f.id, f.type]))
  const optionsOf = new Map(fields.map((f) => [f.id, f.options]))
  const userIds = [
    ...new Set(
      actions.flatMap((a) => (a.type === "notifyUsers" ? a.userIds : [])),
    ),
  ]
  const members = userIds.length
    ? await tx
        .select({ userId: workspaceMemberModel.userId })
        .from(workspaceMemberModel)
        .where(
          and(
            eq(workspaceMemberModel.workspaceId, workspaceId),
            inArray(workspaceMemberModel.userId, userIds),
          ),
        )
    : []
  const memberIds = new Set(members.map((m) => m.userId))

  for (const [index, action] of actions.entries()) {
    const path = `settings.actions.${index}`
    if (action.type === "addPoints") {
      const type = typeOf.get(action.customFieldId)
      if (type !== "number") {
        throw validationException(
          `${path}.customFieldId`,
          type
            ? "Points go into a number field."
            : "That custom field does not exist here.",
        )
      }
      if (mapped.has(action.customFieldId)) {
        throw validationException(
          `${path}.customFieldId`,
          "A question of this form writes that field; points need a field of their own.",
        )
      }
    } else if (action.type === "setField") {
      const type = typeOf.get(action.customFieldId)
      if (!type) {
        throw validationException(
          `${path}.customFieldId`,
          "That custom field does not exist here.",
        )
      }
      try {
        await normalizeCustomFieldValueForStorage({
          type,
          value: action.value,
          options: optionsOf.get(action.customFieldId) ?? null,
          resolveSourceTimezone: () => Promise.resolve("UTC"),
        })
      } catch (error) {
        throw validationException(
          `${path}.value`,
          error instanceof Error
            ? error.message
            : "That value does not fit the field.",
        )
      }
    } else if (action.type === "notifyUsers") {
      const missing = action.userIds.find((id) => !memberIds.has(id))
      if (missing) {
        throw validationException(
          `${path}.userIds`,
          "A notified user is not a member of this workspace.",
        )
      }
    }
  }
}
