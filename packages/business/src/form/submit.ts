import { createHash } from "node:crypto"
import {
  and,
  type DatabaseClient,
  db,
  eq,
  gte,
  inArray,
  isUniqueViolationError,
  sql,
} from "@chatbotx.io/database/client"
import {
  applyHiddenDefaults,
  EMPTY_FORM_DEFINITION,
  evaluateForm,
  FORM_OPTION_FIELD_TYPES,
  type FormDefinition,
  type FormSubmissionVisibility,
  type FormSystemFieldKey,
  type FormValidationIssue,
  type FormValue,
  type FormValues,
  formInputFields,
  formMapsToContact,
  formScore,
  formWindowState,
  normalizeFormSettings,
  pruneFormValues,
  validateFormSubmission,
} from "@chatbotx.io/database/partials"
import {
  contactCustomFieldModel,
  customFieldModel,
  formModel,
  formSubmissionModel,
} from "@chatbotx.io/database/schema"
import type { FormSubmissionModel } from "@chatbotx.io/database/types"
import { emitFormSubmitted } from "@chatbotx.io/events"
import { runWithWebhookExecutionContext } from "@chatbotx.io/events/context"
import { createId, isPlainRecord } from "@chatbotx.io/utils"
import {
  canonicalMultiSelectValue,
  canonicalSelectValue,
  type OptionFieldType,
} from "@chatbotx.io/utils/custom-field"
import { parsePhoneNumberFromString } from "libphonenumber-js"
import { attachContactToInbox } from "../contact/attach-inbox"
import {
  createContactWithInbox,
  resolveDefaultRegion,
} from "../contact/create-with-inbox"
import { splitFullName } from "../contact/full-name"
import { contactService, type RichSystemContactField } from "../contact/service"
import { contactCustomFieldService } from "../contact-custom-field/service"
import { contactInboxService } from "../contact-inbox/service"
import { ChatbotXException } from "../errors"
import { logger } from "../logger"
import { tagService } from "../tag/service"
import { workspaceService } from "../workspace/service"
import { runFormActions } from "./actions"
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

/**
 * Why a published form takes nothing right now (s220c A2-4): outside its
 * window, or its submission limit is reached. `message` is the form's own.
 */
export type FormClosedReason = "pending" | "closed" | "limit"

export type SubmitFormResult =
  | { kind: "notFound" }
  | { kind: "closed"; reason: FormClosedReason; message: string }
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
    fullName: "full_name",
  }

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex")

/**
 * One hash per (workspace, ip): the row never stores the address itself, and
 * the server secret keeps a row reader from brute-forcing IPv4 (2^32 hashes
 * without it; probe, s200).
 */
export const hashClientIp = (workspaceId: string, clientIp: string): string =>
  sha256(
    `${process.env.BETTER_AUTH_SECRET ?? ""}|${workspaceId.length}:${workspaceId}|${clientIp}`,
  )

/** Stable JSON: sorted keys, so `{a,b}` and `{b,a}` hash alike. */
const canonical = (values: FormValues): string =>
  JSON.stringify(
    Object.keys(values)
      .sort()
      .map((k) => [k, values[k]]),
  )

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

type OptionTarget = { type: OptionFieldType; options: string[] }

/**
 * An answer as stored in a select / multiSelect field (s201): the canonical
 * option text, or null when it is not (or no longer) an option. A checkbox
 * group goes in as a JSON array, so an option holding a comma stays one item.
 */
const optionTargetText = (
  value: FormValue,
  target: OptionTarget,
): string | null => {
  if (target.type === "select") {
    return canonicalSelectValue(toStoredText(value), target.options)
  }
  const raw = Array.isArray(value) ? JSON.stringify(value) : toStoredText(value)
  const result = canonicalMultiSelectValue(raw, target.options)
  return result.ok ? result.value : null
}

type Identity = { phoneNumber: string | null; email: string | null }
export type PendingChanges = Awaited<
  ReturnType<typeof contactCustomFieldService.setValuesInTransaction>
>

/** The admission lock wait: a slow holder must not starve the pool. */
const ADMISSION_LOCK_TIMEOUT = "5s"
const ADMISSION_RETRY_AFTER_SECONDS = 5
const ADMISSION_ATTEMPTS = 3
/** Admission counts rows after taking its lock: never a snapshot older than the lock. */
export const ADMISSION_ISOLATION = { isolationLevel: "read committed" } as const

/** Thrown inside the submit / finish transaction to roll it back. */
export class FormNotAdmittedError extends Error {
  readonly reason: FormClosedReason
  constructor(reason: FormClosedReason) {
    super(`form submission not admitted: ${reason}`)
    this.reason = reason
  }
}

const LOCK_NOT_AVAILABLE = "55P03"
/** A Postgres lock_timeout (driver errors may wrap it in `cause`). */
export const isLockTimeout = (error: unknown): boolean => {
  for (let e: unknown = error, depth = 0; e && depth < 4; depth++) {
    if ((e as { code?: unknown }).code === LOCK_NOT_AVAILABLE) {
      return true
    }
    e = (e as { cause?: unknown }).cause
  }
  return false
}

/**
 * Run a chat transaction again when its admission lock wait timed out
 * (blind probe s220c: the worker swallows errors to avoid re-sending the
 * question, so a single timeout would leave the contact's final answer
 * unprocessed). Bounded; the last timeout is rethrown.
 */
export async function retryOnLockTimeout<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run()
    } catch (error) {
      if (!isLockTimeout(error) || attempt >= ADMISSION_ATTEMPTS) {
        throw error
      }
      logger.warn({ attempt }, "form admission: lock wait timed out; retrying")
    }
  }
}

const closedResult = (
  settings: NormalizedForm["settings"],
  reason: FormClosedReason,
): SubmitFormResult => ({
  kind: "closed",
  reason,
  message:
    reason === "pending" ? settings.pendingMessage : settings.closedMessage,
})

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
    const values = applyHiddenDefaults(
      def,
      coerceValues(input.values),
      new Set(settings.prefillKeys),
    )
    const evaluation = evaluateForm(def, values)
    const issues = validateFormSubmission(def, values, evaluation, {
      blockedEmailDomains: settings.blockedEmailDomains ?? [],
    })
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

    // After dedup (a double-click on the last place stays "ok") and before
    // any contact is created; `admit` below is the authoritative check.
    const closed = await this.availability(form, now)
    if (closed !== null) {
      return closedResult(settings, closed)
    }

    // Contact resolution runs BEFORE the transaction: attach / create have
    // their own transactions and emit their own events.
    let contactId: string | null = null
    let contactCreated = false
    let identityIssue: FormValidationIssue | null = null
    if (formMapsToContact(def) && form.inboxId) {
      let resolved: Awaited<ReturnType<FormSubmitService["resolveContact"]>>
      try {
        resolved = await this.resolveContact({
          workspaceId: input.workspaceId,
          inboxId: form.inboxId,
          def,
          values: pruned,
        })
      } catch (error) {
        // A refused attach / create (wrong inbox channel, a workspace rule)
        // is the submitter's typed issue on the identity field, never a bare
        // status that loses their answers (probe P4, s200).
        if (error instanceof ChatbotXException) {
          logger.warn(
            { err: error, workspaceId: input.workspaceId, formId: form.id },
            "form submit: contact resolution refused",
          )
          const key =
            this.identityKeys(def).phone ??
            this.identityKeys(def).email ??
            "values"
          return { kind: "invalid", issues: [{ key, code: "type" }] }
        }
        throw error
      }
      if ("issue" in resolved) {
        identityIssue = resolved.issue
      } else {
        contactId = resolved.contactId
        contactCreated = resolved.created
      }
    }
    if (identityIssue) {
      return { kind: "invalid", issues: [identityIssue] }
    }

    let persisted: {
      row: FormSubmissionModel
      pending: PendingChanges
      duplicateOf: FormSubmissionModel | null
    }
    try {
      persisted = await db.transaction(async (tx) => {
        // Serialise identical answers from one ip: two racing submits both
        // pass the read above; the second waits here and sees the first.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${dedupHash}))`,
        )
        const duplicateOf = await this.findRecentDuplicate({
          form,
          dedupHash,
          now,
          tx,
        })
        if (duplicateOf) {
          return { row: duplicateOf, pending: [], duplicateOf }
        }
        const pending =
          contactId === null
            ? []
            : await this.writeMappedFields({
                workspaceId: input.workspaceId,
                contactId,
                def,
                values: pruned,
                sourceTimezone: input.sourceTimezone,
                // A contact this submission created is ours to fill; an
                // existing contact keeps every non-blank value unless the form
                // owner opted into overwriting (skeptic, s200).
                fillBlanksOnly: !(contactCreated || settings.overwriteExisting),
                tx,
              })
        // Last, so the per-form lock is held only for count + insert +
        // commit; a refusal rolls the contact writes above back.
        const refused = await this.admit(tx, form.id)
        if (refused !== null) {
          throw new FormNotAdmittedError(refused)
        }
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
            channel: "web",
            score: formScore(def, pruned, evaluation),
            ipHash,
            userAgent: input.userAgent?.slice(0, 500) ?? null,
            dedupHash,
          })
          .returning()
        return { row, pending, duplicateOf: null }
      }, ADMISSION_ISOLATION)
    } catch (error) {
      if (error instanceof FormNotAdmittedError || isLockTimeout(error)) {
        if (contactCreated) {
          // resolveContact committed on its own: the contact (and its
          // created events) stays, the submission does not. Only a submit
          // that raced the last place or the close gets here; the
          // pre-check above refuses every other one before any contact.
          logger.warn(
            { workspaceId: input.workspaceId, formId: form.id, contactId },
            "form submit: not admitted after creating the contact",
          )
        }
        return error instanceof FormNotAdmittedError
          ? closedResult(settings, error.reason)
          : { kind: "rateLimited", retryAfter: ADMISSION_RETRY_AFTER_SECONDS }
      }
      if (contactCreated && contactId) {
        // The contact's own transaction committed before ours failed: name
        // the row so it is never a silent orphan.
        logger.warn(
          {
            err: error,
            workspaceId: input.workspaceId,
            formId: form.id,
            contactId,
          },
          "form submit: submission transaction failed after creating the contact",
        )
      }
      throw error
    }

    if (persisted.duplicateOf) {
      return {
        kind: "ok",
        duplicate: true,
        submissionId: persisted.duplicateOf.id,
        contactId: persisted.duplicateOf.contactId,
        successMessage: settings.successMessage,
        redirectUrl: settings.redirectUrl,
      }
    }

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

  /** Stored submissions of one form (web + chat); index FormSubmission_formId_createdAt_idx. */
  async countForForm(formId: string, tx: DatabaseClient = db): Promise<number> {
    const [row] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(formSubmissionModel)
      .where(eq(formSubmissionModel.formId, formId))
    return row?.count ?? 0
  }

  /**
   * Why this form takes nothing at `now` (outside its window, or full), or
   * null when it is open. A READ: the page, the web pre-check and the chat
   * start use it; only `admit` is authoritative.
   */
  async availability(
    form: Pick<NormalizedForm, "id" | "settings">,
    now: Date,
    tx: DatabaseClient = db,
  ): Promise<FormClosedReason | null> {
    const state = formWindowState(form.settings, now)
    if (state !== "open") {
      return state
    }
    const limit = form.settings.submissionLimit ?? null
    if (limit !== null && (await this.countForForm(form.id, tx)) >= limit) {
      return "limit"
    }
    return null
  }

  /**
   * The authoritative admission, inside the caller's transaction and right
   * before its insert (web submit, chat finish). EVERY submission of the
   * form takes the per-form advisory lock, held to commit, then re-reads the
   * form's settings and the clock: so N racing submits against a limit of L
   * store exactly min(N, L) rows (Mautic checks, then inserts, and
   * overshoots), a limit saved while a submit was in flight still binds it
   * (blind probe s220c), and a window that closed meanwhile refuses it. The
   * lock wait is bounded (ADMISSION_LOCK_TIMEOUT); the web maps a timeout to
   * "try again", chat retries (retryOnLockTimeout). Callers run READ
   * COMMITTED so the count after the lock sees every row the previous holder
   * committed. The settings are those committed when the lock was taken: a
   * save that commits DURING the admission binds the next submission, not
   * this one (the contract is admission time).
   */
  async admit(
    tx: DatabaseClient,
    formId: string,
  ): Promise<FormClosedReason | null> {
    // Bound only this wait, then give the caller back ITS timeout (a reset
    // to DEFAULT would drop a timeout the caller set; blind probe s220c).
    const saved = await tx.execute<{ previous: string }>(
      sql`select current_setting('lock_timeout') as previous`,
    )
    await tx.execute(
      sql`select set_config('lock_timeout', ${ADMISSION_LOCK_TIMEOUT}, true)`,
    )
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`form-limit:${formId}`}, 0))`,
    )
    await tx.execute(
      sql`select set_config('lock_timeout', ${saved.rows[0]?.previous ?? "0"}, true)`,
    )
    const [row] = await tx
      .select({ settings: formModel.settings })
      .from(formModel)
      .where(eq(formModel.id, formId))
    if (!row) {
      return "closed"
    }
    const settings = normalizeFormSettings(row.settings)
    const limit = settings.submissionLimit ?? null
    if (limit !== null && (await this.countForForm(formId, tx)) >= limit) {
      return "limit"
    }
    // The clock LAST, after every await of the admission (blind probe s220c):
    // the contract is "admitted before the close"; the insert follows at once.
    const state = formWindowState(settings, new Date())
    return state === "open" ? null : state
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

  /** The field keys that carry the contact identity, if any. */
  private identityKeys(def: FormDefinition): {
    phone?: string
    email?: string
  } {
    const out: { phone?: string; email?: string } = {}
    for (const field of formInputFields(def)) {
      if (field.mapTo?.kind !== "system") {
        continue
      }
      if (field.mapTo.key === "phoneNumber") {
        out.phone = field.key
      } else if (field.mapTo.key === "email") {
        out.email = field.key
      }
    }
    return out
  }

  /** The phone / email answers mapped to the contact, normalised. Shared with FormSessionService (s219 A2-2). */
  async identityOf(props: {
    workspaceId: string
    def: FormDefinition
    values: FormValues
    /** Inside a transaction, the workspace read MUST use it (one pool connection per tx). */
    tx?: DatabaseClient
  }): Promise<
    | { identity: Identity; keys: { phone?: string; email?: string } }
    | { issue: FormValidationIssue }
  > {
    const { workspaceId, def, values, tx } = props
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
        tx,
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
  }): Promise<
    | { contactId: string | null; created: boolean }
    | { issue: FormValidationIssue }
  > {
    const { workspaceId, inboxId, def, values } = props
    const found = await this.identityOf({ workspaceId, def, values })
    if ("issue" in found) {
      return found
    }
    const { phoneNumber, email } = found.identity
    if (!(phoneNumber || email)) {
      return { contactId: null, created: false }
    }
    const sourceId = phoneNumber ?? (email as string)

    const lookup = async () => {
      let existing = phoneNumber
        ? await contactService.findByPhone({ workspaceId, phoneNumber })
        : undefined
      if (!existing && email) {
        existing = await db.query.contactModel.findFirst({
          where: { workspaceId, email },
        })
      }
      return existing
    }
    const existing = await lookup()

    if (existing) {
      try {
        const attached = await attachContactToInbox({
          workspaceId,
          contactId: existing.id,
          inboxId,
          sourceId,
          onConflict: "resolve",
        })
        return { contactId: attached.contactInbox.contactId, created: false }
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
            return { contactId: owner.contactId, created: false }
          }
        }
        throw error
      }
    }

    const names = this.namesOf(def, values)
    try {
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
      return { contactId: contact.id, created: true }
    } catch (error) {
      // Two submissions racing on one new identity: the loser's create is
      // refused ("Phone number is exists" / the inbox identity constraint);
      // the winner's row is the contact to write to, never an error.
      if (error instanceof ChatbotXException || isUniqueViolationError(error)) {
        const winner = await lookup()
        if (winner) {
          return { contactId: winner.id, created: false }
        }
        const owner = await contactInboxService.findLatestBySource({
          inboxId,
          sourceId,
          workspaceId,
        })
        if (owner) {
          return { contactId: owner.contactId, created: false }
        }
      }
      throw error
    }
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
      } else if (field.mapTo.key === "fullName") {
        const { firstName, lastName } = splitFullName(value)
        out.firstName = firstName ?? undefined
        out.lastName = lastName ?? undefined
      }
    }
    return out
  }

  /** Non-blank mapped answers -> system fields and custom fields, inside `tx`. Shared with FormSessionService (s219 A2-2). */
  async writeMappedFields(props: {
    workspaceId: string
    contactId: string
    def: FormDefinition
    values: FormValues
    sourceTimezone?: string
    /** Existing contact, no opt-in: write only where nothing is stored yet. */
    fillBlanksOnly: boolean
    tx: DatabaseClient
  }): Promise<PendingChanges> {
    const {
      workspaceId,
      contactId,
      def,
      values,
      sourceTimezone,
      fillBlanksOnly,
      tx,
    } = props
    const stored = fillBlanksOnly
      ? await this.storedValues({ workspaceId, contactId, def, tx })
      : null
    const custom: { customFieldId: string; value: string; key: string }[] = []
    const optionTargets = await this.optionTargets({ workspaceId, def, tx })
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
      if (
        stored &&
        (field.mapTo.kind === "system"
          ? stored.system[field.mapTo.key]
          : stored.custom.has(field.mapTo.customFieldId))
      ) {
        continue
      }
      if (field.mapTo.kind === "system") {
        const text = toStoredText(value).trim()
        if (text === "") {
          continue
        }
        if (stored && field.mapTo.key === "fullName") {
          // Fill-blanks: write only the half the contact is missing, never
          // replace a stored first or last name (s219).
          const parts = splitFullName(text)
          for (const [key, fieldName, part] of [
            ["firstName", "first_name", parts.firstName],
            ["lastName", "last_name", parts.lastName],
          ] as const) {
            if (part && !stored.system[key]) {
              await contactService.setRichSystemFieldByKey({
                workspaceId,
                contactId,
                fieldName,
                value: part,
                tx,
              })
            }
          }
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
        const target = optionTargets.get(field.mapTo.customFieldId)
        const stored = target
          ? optionTargetText(value, target)
          : toStoredText(value)
        if (stored === null) {
          // The field's options changed after this form was published (the
          // publish check passed then): keep the submission, skip the write.
          logger.warn(
            {
              workspaceId,
              contactId,
              fieldKey: field.key,
              customFieldId: field.mapTo.customFieldId,
            },
            "form submit: answer is no longer an option of the mapped field; not written",
          )
          continue
        }
        if (stored === "") {
          continue
        }
        custom.push({
          customFieldId: field.mapTo.customFieldId,
          value: stored,
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

  /** The mapped custom fields of an option type, with their option lists. */
  private async optionTargets(props: {
    workspaceId: string
    def: FormDefinition
    tx: DatabaseClient
  }): Promise<Map<string, OptionTarget>> {
    // Publish admits only a choice field into a select / multiSelect target
    // (formMappingIssue), so a form without one never needs this lookup.
    const ids = formInputFields(props.def).flatMap((f) =>
      f.mapTo?.kind === "custom" && FORM_OPTION_FIELD_TYPES.has(f.type)
        ? [f.mapTo.customFieldId]
        : [],
    )
    if (ids.length === 0) {
      return new Map()
    }
    const rows = await props.tx
      .select({
        id: customFieldModel.id,
        type: customFieldModel.type,
        options: customFieldModel.options,
      })
      .from(customFieldModel)
      .where(
        and(
          eq(customFieldModel.workspaceId, props.workspaceId),
          inArray(customFieldModel.id, ids),
          inArray(customFieldModel.type, ["select", "multiSelect"]),
        ),
      )
    return new Map(
      rows.map((r) => [
        String(r.id),
        { type: r.type as OptionFieldType, options: r.options ?? [] },
      ]),
    )
  }

  /** What the contact already holds for the mapped fields (blank = absent). Shared with FormSessionService (s219 A2-2). */
  async storedValues(props: {
    workspaceId: string
    contactId: string
    def: FormDefinition
    tx: DatabaseClient
  }): Promise<{
    system: Record<FormSystemFieldKey, boolean>
    custom: Set<string>
  }> {
    const { workspaceId, contactId, def, tx } = props
    const contact = await contactService.findById({
      workspaceId,
      id: contactId,
      tx,
    })
    const filled = (v: unknown) => typeof v === "string" && v.trim() !== ""
    const system: Record<FormSystemFieldKey, boolean> = {
      firstName: filled(contact?.firstName),
      lastName: filled(contact?.lastName),
      email: filled(contact?.email),
      phoneNumber: filled(contact?.phoneNumber),
      // Skipped only when BOTH halves are stored; a half-known name is topped
      // up part by part in writeMappedFields.
      fullName: filled(contact?.firstName) && filled(contact?.lastName),
    }
    const ids = formInputFields(def)
      .map((f) => (f.mapTo?.kind === "custom" ? f.mapTo.customFieldId : null))
      .filter((v): v is string => v !== null)
    const custom = new Set<string>()
    if (ids.length > 0) {
      const rows = await tx
        .select({
          customFieldId: contactCustomFieldModel.customFieldId,
          value: contactCustomFieldModel.value,
        })
        .from(contactCustomFieldModel)
        .where(
          and(
            eq(contactCustomFieldModel.contactId, contactId),
            inArray(contactCustomFieldModel.customFieldId, ids),
          ),
        )
      for (const row of rows) {
        if (filled(row.value)) {
          custom.add(String(row.customFieldId))
        }
      }
    }
    return { system, custom }
  }

  /**
   * Events and tags only after the row is committed; a failure is logged,
   * never surfaced. Shared by the web submit and the chat run (s219 A2-2), so
   * both channels tag and trigger alike.
   */
  async afterCommit(props: {
    workspaceId: string
    contactId: string
    form: Pick<NormalizedForm, "id" | "slug" | "title" | "settings">
    submission: FormSubmissionModel
    values: FormValues
    pending: PendingChanges
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
    // A submission is the CONTACT's act, like a channel message: without the
    // webhook context the webhook emitter drops it (web `form_submitted`
    // webhooks never fired; chat runs already had the context). s220c A2-4.
    await runWithWebhookExecutionContext({ source: "webhook" }, () =>
      emitFormSubmitted(workspaceId, contactId, {
        formId: form.id,
        formSlug: form.slug,
        submissionId: submission.id,
        definitionVersion: submission.definitionVersion,
        values,
        channel: submission.channel,
        conversationId: submission.conversationId ?? null,
        score: submission.score ?? null,
        occurredAt: submission.createdAt.toISOString(),
      }),
    ).catch(warn("formSubmitted event"))
    // s220 A2-3: the form's action catalogue (points, fields, tags, notify).
    await runFormActions({
      db,
      workspaceId,
      contactId,
      form: { id: form.id, title: form.title, actions: form.settings.actions },
      submission,
      notify: async (input) => {
        // lazy: the notification service's import graph (members, realtime,
        // queues) must not load with every form submit's module
        const { notificationService } = await import("../notification/service")
        await notificationService.notifyFormSubmission(input)
      },
    }).catch(warn("form actions"))
  }
}

export const formSubmitService = new FormSubmitService()
