import { createHash } from "node:crypto"
import {
  and,
  type DatabaseClient,
  db,
  eq,
  gte,
  sql,
} from "@chatbotx.io/database/client"
import {
  EMPTY_FORM_DEFINITION,
  evaluateForm,
  type FormDefinition,
  type FormSubmissionVisibility,
  type FormSystemFieldKey,
  type FormValidationIssue,
  type FormValue,
  type FormValues,
  formInputFields,
  formMapsToContact,
  pruneFormValues,
  validateFormSubmission,
} from "@chatbotx.io/database/partials"
import { contactModel, formSubmissionModel } from "@chatbotx.io/database/schema"
import type { FormSubmissionModel } from "@chatbotx.io/database/types"
import { emitFormSubmitted } from "@chatbotx.io/events"
import { createId } from "@chatbotx.io/utils"
import { parsePhoneNumberFromString } from "libphonenumber-js"
import { attachContactToInbox } from "../contact/attach-inbox"
import {
  createContactWithInbox,
  resolveDefaultRegion,
} from "../contact/create-with-inbox"
import { contactService, type RichSystemContactField } from "../contact/service"
import { contactCustomFieldService } from "../contact-custom-field/service"
import { contactInboxService } from "../contact-inbox/service"
import { ChatbotXException } from "../errors"
import { logger } from "../logger"
import { tagService } from "../tag/service"
import { workspaceService } from "../workspace/service"
import { formService, type NormalizedForm } from "./service"

/**
 * The public submit pipeline (s200, PR2), in this order:
 *   honeypot -> load published form -> evaluate + validate (visible fields
 *   only) -> dedup (same answers + ip within 300 s) -> per-form-per-ip hourly
 *   budget -> contact resolve (owner-first on the form's API inbox) -> ONE
 *   transaction (system + custom fields, non-blank only; the submission row)
 *   -> after commit: custom-field events, tags, `formSubmitted`.
 *
 * Every refusal is a typed result, never a throw, so the route maps it to a
 * status without a catch-all. A blank answer never clears a stored value
 * (sober-af-forms rule). Rate limiting by ip alone lives in the route.
 */

export const FORM_DEDUP_WINDOW_SECONDS = 300
export const FORM_BUDGET_WINDOW_SECONDS = 3600

export type SubmitFormInput = {
  workspaceId: string
  slug: string
  /** The raw JSON `values` object; anything not a plain object is invalid. */
  values: unknown
  /** True when the hidden honeypot field carried a value. */
  honeypotFilled: boolean
  clientIp: string
  userAgent: string | null
  /** The submitter's browser zone, anchors naive date answers. */
  sourceTimezone?: string
  now?: Date
}

export type SubmitFormResult =
  | { kind: "notFound" }
  | { kind: "invalid"; issues: FormValidationIssue[] }
  | { kind: "rateLimited"; retryAfter: number }
  | {
      kind: "ok"
      duplicate: boolean
      submissionId: string | null
      contactId: string | null
      successMessage: string
      redirectUrl: string | null
    }

const SYSTEM_KEY_TO_FIELD: Record<FormSystemFieldKey, RichSystemContactField> =
  {
    firstName: "first_name",
    lastName: "last_name",
    email: "email",
    phoneNumber: "phone_number",
  }

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex")

/** One hash per (workspace, ip): the row never stores the address itself. */
export const hashClientIp = (workspaceId: string, clientIp: string): string =>
  sha256(`${workspaceId}:${clientIp}`)

/** Stable JSON: sorted keys, so `{a,b}` and `{b,a}` hash alike. */
const canonical = (values: FormValues): string =>
  JSON.stringify(
    Object.keys(values)
      .sort()
      .map((k) => [k, values[k]]),
  )

const isPlainRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)

/** Keep only JSON shapes the evaluator understands; anything else reads as absent. */
const coerceValues = (raw: Record<string, unknown>): FormValues => {
  const out: FormValues = {}
  for (const [key, value] of Object.entries(raw)) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      out[key] = value
    } else if (Array.isArray(value)) {
      out[key] = value.filter((v): v is string => typeof v === "string")
    }
  }
  return out
}

/** A stored custom-field value is text: lists join with ", ", booleans are true/false. */
const toStoredText = (value: FormValue): string => {
  if (Array.isArray(value)) {
    return value.join(", ")
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false"
  }
  return String(value ?? "")
}

type Identity = { phoneNumber: string | null; email: string | null }

export class FormSubmitService {
  async submit(input: SubmitFormInput): Promise<SubmitFormResult> {
    const now = input.now ?? new Date()
    const form = await formService.findPublishedBySlug({
      workspaceId: input.workspaceId,
      slug: input.slug,
    })
    if (!form) {
      return { kind: "notFound" }
    }
    const def = form.publishedDefinition ?? EMPTY_FORM_DEFINITION
    const settings = form.settings

    if (settings.honeypot && input.honeypotFilled) {
      logger.info(
        { workspaceId: input.workspaceId, formId: form.id },
        "form submit: honeypot filled, dropped",
      )
      return {
        kind: "ok",
        duplicate: false,
        submissionId: null,
        contactId: null,
        successMessage: settings.successMessage,
        redirectUrl: settings.redirectUrl,
      }
    }

    if (!isPlainRecord(input.values)) {
      return { kind: "invalid", issues: [{ key: "values", code: "type" }] }
    }
    const values = coerceValues(input.values)
    const evaluation = evaluateForm(def, values)
    const issues = validateFormSubmission(def, values, evaluation)
    if (issues.length > 0) {
      return { kind: "invalid", issues }
    }
    const pruned = pruneFormValues(def, values, evaluation)
    const visibility: FormSubmissionVisibility = {
      steps: [...evaluation.visibleSteps],
      fields: [...evaluation.visibleFields],
    }
    const ipHash = hashClientIp(input.workspaceId, input.clientIp)
    const dedupHash = sha256(`${form.id}|${canonical(pruned)}|${ipHash}`)

    const duplicate = await this.findRecentDuplicate({ form, dedupHash, now })
    if (duplicate) {
      return {
        kind: "ok",
        duplicate: true,
        submissionId: duplicate.id,
        contactId: duplicate.contactId,
        successMessage: settings.successMessage,
        redirectUrl: settings.redirectUrl,
      }
    }

    const used = await this.countRecentByIp({ form, ipHash, now })
    if (used >= settings.submitLimitPerIpPerHour) {
      return { kind: "rateLimited", retryAfter: FORM_BUDGET_WINDOW_SECONDS }
    }

    // Contact resolution runs BEFORE the transaction: attach / create have
    // their own transactions and emit their own events.
    let contactId: string | null = null
    let identityIssue: FormValidationIssue | null = null
    if (formMapsToContact(def) && form.inboxId) {
      const resolved = await this.resolveContact({
        workspaceId: input.workspaceId,
        inboxId: form.inboxId,
        def,
        values: pruned,
      })
      if ("issue" in resolved) {
        identityIssue = resolved.issue
      } else {
        contactId = resolved.contactId
      }
    }
    if (identityIssue) {
      return { kind: "invalid", issues: [identityIssue] }
    }

    const persisted = await db.transaction(async (tx) => {
      const pending =
        contactId === null
          ? []
          : await this.writeMappedFields({
              workspaceId: input.workspaceId,
              contactId,
              def,
              values: pruned,
              sourceTimezone: input.sourceTimezone,
              tx,
            })
      const [row] = await tx
        .insert(formSubmissionModel)
        .values({
          id: createId(),
          workspaceId: input.workspaceId,
          formId: form.id,
          contactId,
          definitionVersion: form.definitionVersion,
          values: pruned,
          visibility,
          ipHash,
          userAgent: input.userAgent?.slice(0, 500) ?? null,
          dedupHash,
        })
        .returning()
      return { row, pending }
    })

    if (contactId !== null) {
      await this.afterCommit({
        workspaceId: input.workspaceId,
        contactId,
        form,
        submission: persisted.row,
        values: pruned,
        pending: persisted.pending,
      })
    }

    return {
      kind: "ok",
      duplicate: false,
      submissionId: persisted.row.id,
      contactId,
      successMessage: settings.successMessage,
      redirectUrl: settings.redirectUrl,
    }
  }

  private async findRecentDuplicate(props: {
    form: NormalizedForm
    dedupHash: string
    now: Date
    tx?: DatabaseClient
  }): Promise<FormSubmissionModel | undefined> {
    const { form, dedupHash, now, tx = db } = props
    const since = new Date(now.getTime() - FORM_DEDUP_WINDOW_SECONDS * 1000)
    const [row] = await tx
      .select()
      .from(formSubmissionModel)
      .where(
        and(
          eq(formSubmissionModel.formId, form.id),
          eq(formSubmissionModel.dedupHash, dedupHash),
          gte(formSubmissionModel.createdAt, since),
        ),
      )
      .limit(1)
    return row
  }

  private async countRecentByIp(props: {
    form: NormalizedForm
    ipHash: string
    now: Date
    tx?: DatabaseClient
  }): Promise<number> {
    const { form, ipHash, now, tx = db } = props
    const since = new Date(now.getTime() - FORM_BUDGET_WINDOW_SECONDS * 1000)
    const [row] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(formSubmissionModel)
      .where(
        and(
          eq(formSubmissionModel.formId, form.id),
          eq(formSubmissionModel.ipHash, ipHash),
          gte(formSubmissionModel.createdAt, since),
        ),
      )
    return Number(row?.count ?? 0)
  }

  /** The phone / email answers mapped to the contact, normalised. */
  private async identityOf(props: {
    workspaceId: string
    def: FormDefinition
    values: FormValues
  }): Promise<
    | { identity: Identity; keys: { phone?: string; email?: string } }
    | { issue: FormValidationIssue }
  > {
    const { workspaceId, def, values } = props
    let phoneKey: string | undefined
    let emailKey: string | undefined
    for (const field of formInputFields(def)) {
      if (field.mapTo?.kind !== "system") {
        continue
      }
      if (field.mapTo.key === "phoneNumber") {
        phoneKey = field.key
      } else if (field.mapTo.key === "email") {
        emailKey = field.key
      }
    }
    const rawPhone = phoneKey ? values[phoneKey] : undefined
    const rawEmail = emailKey ? values[emailKey] : undefined
    let phoneNumber: string | null = null
    if (typeof rawPhone === "string" && rawPhone.trim() !== "") {
      const workspace = await workspaceService.find({
        where: { id: workspaceId },
      })
      const parsed = parsePhoneNumberFromString(
        rawPhone,
        resolveDefaultRegion(workspace?.targetCountry),
      )
      if (!parsed) {
        return { issue: { key: phoneKey as string, code: "phone" } }
      }
      phoneNumber = parsed.number
    }
    const email =
      typeof rawEmail === "string" && rawEmail.trim() !== ""
        ? rawEmail.trim().toLowerCase()
        : null
    return {
      identity: { phoneNumber, email },
      keys: { phone: phoneKey, email: emailKey },
    }
  }

  /**
   * Owner-first: an existing contact with this phone (then email) is attached
   * to the form's API inbox with `onConflict: "resolve"`, which returns the
   * OWNER of that channel identity when another contact already holds it;
   * otherwise a new contact is created on the inbox. No identity answer at
   * all = an anonymous submission (`contactId` null), never a refusal.
   */
  private async resolveContact(props: {
    workspaceId: string
    inboxId: string
    def: FormDefinition
    values: FormValues
  }): Promise<{ contactId: string | null } | { issue: FormValidationIssue }> {
    const { workspaceId, inboxId, def, values } = props
    const found = await this.identityOf({ workspaceId, def, values })
    if ("issue" in found) {
      return found
    }
    const { phoneNumber, email } = found.identity
    if (!(phoneNumber || email)) {
      return { contactId: null }
    }
    const sourceId = phoneNumber ?? (email as string)

    let existing = phoneNumber
      ? await contactService.findByPhone({ workspaceId, phoneNumber })
      : undefined
    if (!existing && email) {
      existing = await db.query.contactModel.findFirst({
        where: { workspaceId, email },
      })
    }

    if (existing) {
      try {
        const attached = await attachContactToInbox({
          workspaceId,
          contactId: existing.id,
          inboxId,
          sourceId,
          onConflict: "resolve",
        })
        return { contactId: attached.contactInbox.contactId }
      } catch (error) {
        // The identity belongs to another contact that has no DM conversation
        // yet: write to that owner rather than refuse the submission.
        if (
          error instanceof ChatbotXException &&
          error.code === "contactInboxOwnedByAnotherContact"
        ) {
          const owner = await contactInboxService.findLatestBySource({
            inboxId,
            sourceId,
            workspaceId,
          })
          if (owner) {
            return { contactId: owner.contactId }
          }
        }
        throw error
      }
    }

    const names = this.namesOf(def, values)
    const { contact } = await createContactWithInbox({
      workspaceId,
      input: {
        email: email ?? "",
        phoneNumber: phoneNumber ?? undefined,
        firstName: names.firstName,
        lastName: names.lastName,
        gender: null,
        channel: "api",
        inboxId,
        contactId: sourceId,
      },
    })
    // Same identity on the same inbox: the constraint refused a duplicate,
    // so `findLatestBySource` names the row that won.
    return { contactId: contact.id }
  }

  private namesOf(
    def: FormDefinition,
    values: FormValues,
  ): { firstName?: string; lastName?: string } {
    const out: { firstName?: string; lastName?: string } = {}
    for (const field of formInputFields(def)) {
      if (field.mapTo?.kind !== "system") {
        continue
      }
      const value = values[field.key]
      if (typeof value !== "string" || value.trim() === "") {
        continue
      }
      if (field.mapTo.key === "firstName") {
        out.firstName = value.trim()
      } else if (field.mapTo.key === "lastName") {
        out.lastName = value.trim()
      }
    }
    return out
  }

  /** Non-blank mapped answers -> system fields and custom fields, inside `tx`. */
  private async writeMappedFields(props: {
    workspaceId: string
    contactId: string
    def: FormDefinition
    values: FormValues
    sourceTimezone?: string
    tx: DatabaseClient
  }) {
    const { workspaceId, contactId, def, values, sourceTimezone, tx } = props
    const custom: { customFieldId: string; value: string; key: string }[] = []
    for (const field of formInputFields(def)) {
      const value = values[field.key]
      if (
        !field.mapTo ||
        value === undefined ||
        value === null ||
        value === ""
      ) {
        continue
      }
      if (field.mapTo.kind === "system") {
        const text = toStoredText(value).trim()
        if (text === "") {
          continue
        }
        await contactService.setRichSystemFieldByKey({
          workspaceId,
          contactId,
          fieldName: SYSTEM_KEY_TO_FIELD[field.mapTo.key],
          value: text,
          tx,
        })
      } else {
        custom.push({
          customFieldId: field.mapTo.customFieldId,
          value: toStoredText(value),
          key: field.key,
        })
      }
    }
    if (custom.length === 0) {
      return []
    }
    return await contactCustomFieldService.setValuesInTransaction(
      {
        workspaceId,
        contactId,
        fields: custom.map(({ customFieldId, value }) => ({
          customFieldId,
          value,
        })),
        sourceTimezone,
      },
      tx,
    )
  }

  /** Events and tags only after the row is committed; a failure is logged, never surfaced. */
  private async afterCommit(props: {
    workspaceId: string
    contactId: string
    form: NormalizedForm
    submission: FormSubmissionModel
    values: FormValues
    pending: Awaited<
      ReturnType<typeof contactCustomFieldService.setValuesInTransaction>
    >
  }): Promise<void> {
    const { workspaceId, contactId, form, submission, values, pending } = props
    const warn = (what: string) => (error: unknown) =>
      logger.warn(
        { err: error, workspaceId, formId: form.id, contactId },
        `form submit: ${what} failed after commit`,
      )
    await contactCustomFieldService
      .emitCustomFieldChanges({ workspaceId, contactId, changes: pending })
      .catch(warn("custom-field events"))
    if (form.settings.tags.length > 0) {
      await tagService
        .attachByNamesToContacts({
          workspaceId,
          contactIds: [contactId],
          names: form.settings.tags,
        })
        .catch(warn("tags"))
    }
    await emitFormSubmitted(workspaceId, contactId, {
      formId: form.id,
      formSlug: form.slug,
      submissionId: submission.id,
      definitionVersion: form.definitionVersion,
      values,
    }).catch(warn("formSubmitted event"))
  }
}

export const formSubmitService = new FormSubmitService()

/** The `contact` table is referenced so the import is not dead when tree-shaken. */
export const FORM_SUBMIT_CONTACT_TABLE = contactModel
