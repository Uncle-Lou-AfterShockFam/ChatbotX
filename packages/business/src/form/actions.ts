import {
  and,
  type DatabaseClient,
  eq,
  inArray,
} from "@chatbotx.io/database/client"
import type { FormAction } from "@chatbotx.io/database/partials"
import { customFieldModel } from "@chatbotx.io/database/schema"
import type { FormSubmissionModel } from "@chatbotx.io/database/types"
import { FieldOperationType } from "@chatbotx.io/flow-config"
import { contactCustomFieldService } from "../contact-custom-field/service"
import { logger } from "../logger"
import { tagService } from "../tag/service"

/**
 * The form-action catalogue (s220 A2-3): what a submission does after it is
 * written, web and chat alike. Save-time checks (`action-refs.ts`) refuse a
 * reference that does not exist now; run-time skips one that went stale
 * since (a deleted field or a removed member), with a log, and never fails
 * the submission.
 */

type FormActionOf<T extends FormAction["type"]> = Extract<
  FormAction,
  { type: T }
>

export type FormActionNotify = (props: {
  workspaceId: string
  contactId: string
  userIds: string[]
  formId: string
  formTitle: string
  submission: FormSubmissionModel
}) => Promise<void>

/**
 * Run a submission's actions once, after its commit. Each field batch emits
 * its events after it commits; a stale field is dropped first so it cannot
 * roll the rest of its batch back.
 */
export async function runFormActions(props: {
  db: DatabaseClient
  workspaceId: string
  contactId: string
  form: { id: string; title: string; actions: FormAction[] }
  submission: FormSubmissionModel
  notify: FormActionNotify
}): Promise<void> {
  const { workspaceId, contactId, form, submission } = props
  if (form.actions.length === 0) {
    return
  }
  const warn = (what: string) => (error: unknown) =>
    logger.warn(
      { err: error, workspaceId, formId: form.id, submissionId: submission.id },
      `form action: ${what} failed`,
    )
  const of = <T extends FormAction["type"]>(type: T) =>
    form.actions.filter((a): a is FormActionOf<T> => a.type === type)

  // Points and set values are separate batches: a set that the field
  // refuses at write time must not roll the points back (skeptic, s220).
  await runFieldActions({ ...props, points: of("addPoints"), sets: [] }).catch(
    warn("points"),
  )
  await runFieldActions({ ...props, points: [], sets: of("setField") }).catch(
    warn("set field"),
  )

  const removeNames = [...new Set(of("removeTags").flatMap((a) => a.names))]
  if (removeNames.length > 0) {
    await tagService
      .detachByNamesFromContacts({
        workspaceId,
        contactIds: [contactId],
        names: removeNames,
      })
      .catch(warn("remove tags"))
  }

  const userIds = [...new Set(of("notifyUsers").flatMap((a) => a.userIds))]
  if (userIds.length > 0) {
    await props
      .notify({
        workspaceId,
        contactId,
        userIds,
        formId: form.id,
        formTitle: form.title,
        submission,
      })
      .catch(warn("notify"))
  }
}

async function runFieldActions(props: {
  db: DatabaseClient
  workspaceId: string
  contactId: string
  form: { id: string }
  submission: FormSubmissionModel
  points: FormActionOf<"addPoints">[]
  sets: FormActionOf<"setField">[]
}): Promise<void> {
  const { workspaceId, contactId, submission } = props
  const score = submission.score ?? 0
  const pointOps =
    score === 0
      ? []
      : props.points.map((a) => ({
          customFieldId: a.customFieldId,
          operation:
            score > 0
              ? FieldOperationType.increase
              : FieldOperationType.decrease,
          value: String(Math.abs(score)),
          wantNumber: true,
        }))
  const setOps = props.sets.map((a) => ({
    customFieldId: a.customFieldId,
    operation: FieldOperationType.set,
    value: a.value,
    wantNumber: false,
  }))
  const ops = [...pointOps, ...setOps]
  if (ops.length === 0) {
    return
  }
  const fields = await props.db
    .select({ id: customFieldModel.id, type: customFieldModel.type })
    .from(customFieldModel)
    .where(
      and(
        eq(customFieldModel.workspaceId, workspaceId),
        inArray(
          customFieldModel.id,
          ops.map((o) => o.customFieldId),
        ),
      ),
    )
  const typeOf = new Map(fields.map((f) => [f.id, f.type]))
  const live = ops.filter((o) => {
    const type = typeOf.get(o.customFieldId)
    const ok = type !== undefined && (!o.wantNumber || type === "number")
    if (!ok) {
      logger.warn(
        { workspaceId, formId: props.form.id, customFieldId: o.customFieldId },
        "form action: field is gone or no longer a number; skipped",
      )
    }
    return ok
  })
  if (live.length === 0) {
    return
  }
  await contactCustomFieldService.applyOperations({
    workspaceId,
    contactId,
    operations: live.map(({ customFieldId, operation, value }) => ({
      customFieldId,
      operation,
      value,
    })),
  })
}
