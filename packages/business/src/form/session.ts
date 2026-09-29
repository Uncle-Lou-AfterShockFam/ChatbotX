import {
  and,
  type DatabaseClient,
  db,
  desc,
  eq,
  inArray,
  isUniqueViolationError,
  lte,
  ne,
} from "@chatbotx.io/database/client"
import {
  evaluateForm,
  type FormChatPlan,
  type FormDefinition,
  type FormField,
  type FormSessionProfile,
  type FormSubmissionVisibility,
  type FormValues,
  formInputFields,
  formScore,
  isEmptyFormValue,
  isFormChatSkip,
  normalizeFormDefinition,
  parseFormChatAnswer,
  planFormChat,
  pruneFormValues,
  validateFormSubmission,
} from "@chatbotx.io/database/partials"
import {
  contactModel,
  formSessionModel,
  formSubmissionModel,
} from "@chatbotx.io/database/schema"
import type {
  FormSessionModel,
  FormSubmissionModel,
} from "@chatbotx.io/database/types"
import { createId, isPlainRecord } from "@chatbotx.io/utils"
import { logger } from "../logger"
import { formService, type NormalizedForm } from "./service"
import { formSubmitService, type PendingChanges } from "./submit"

/**
 * The chat run of a form (s219 A2-2): the `form` flow step asks one question
 * per message, and this service owns every state change of the run under a
 * row lock. The worker only sends what an action names and routes the flow.
 *
 * Every public method returns a typed action, never throws on a contact's
 * input: a stale, duplicate or unknown reply is `ignored`, a bad answer is a
 * retry `ask`, an exhausted question ends the run `skipped`.
 */

export const FORM_SESSION_HISTORY_CAP = 200
export const DEFAULT_FORM_CHAT_TIMEOUT_MINUTES = 1440
export const DEFAULT_FORM_CHAT_MAX_ATTEMPTS = 3
export const MAX_FORM_CHAT_TIMEOUT_MINUTES = 30 * 24 * 60
export const MAX_FORM_CHAT_MAX_ATTEMPTS = 10

export type FormChatAction =
  | {
      kind: "ask"
      session: FormSessionModel
      field: FormField
      /** Heading / paragraph blocks to send before the question. */
      preface: FormField[]
      /** True when this re-asks after an answer that did not validate. */
      retry: boolean
    }
  | {
      kind: "completed"
      session: FormSessionModel
      submission: FormSubmissionModel
      preface: FormField[]
    }
  | { kind: "ended"; session: FormSessionModel; reason: "attempts" }
  | { kind: "unavailable"; reason: "formNotFound" | "busy" }
  | {
      kind: "ignored"
      reason: "noSession" | "duplicate" | "stale" | "otherStep" | "expired"
    }

export type StartFormSessionInput = {
  workspaceId: string
  formId: string
  contactId: string
  conversationId: string
  contactInboxId: string
  flowId: string
  flowVersionId: string | null
  nodeId: string
  stepId: string
  /** When the flow run began; the sweep re-enters the flow with it. */
  runStartedAt?: Date | null
  timeoutMinutes?: number
  maxAttempts?: number
  now?: Date
}

/**
 * The reply being answered: a stored message, or a picker's challenge id.
 * A message is read UNDER the row lock, against the question it actually
 * answers (a photo, a location and a date each read differently), so a reply
 * that raced the previous answer is never parsed as the wrong field.
 */
export type FormChatReply =
  | {
      messageId: string
      read: (field: FormField) => Promise<string | null> | string | null
    }
  | { challengeId: string; text: string | null }

export type AnswerFormSessionInput = {
  workspaceId: string
  contactId: string
  stepId: string
  reply: FormChatReply
  now?: Date
}

type Finished = {
  action: Extract<FormChatAction, { kind: "completed" }>
  form: NormalizedForm
  pending: PendingChanges
  values: FormValues
}

type Step =
  | { action: Exclude<FormChatAction, { kind: "completed" }> }
  | { finished: Finished }

const clampInt = (
  value: number | undefined,
  fallback: number,
  max: number,
): number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1
    ? Math.min(value, max)
    : fallback

const addMinutes = (at: Date, minutes: number): Date =>
  new Date(at.getTime() + minutes * 60_000)

const SNOWFLAKE_RE = /^\d{1,19}$/
const INT8_MAX = 2n ** 63n - 1n

/**
 * `askMarker` while the question is not yet delivered: no message id is
 * above it, so nothing answers a question the contact has not seen. The
 * worker swaps in a real marker once the send completed (`markAsked`).
 */
export const FORM_ASK_PENDING_MARKER = INT8_MAX.toString()

/** Snowflake ids only; anything else can never be compared to the marker. */
const toSnowflake = (value: string): bigint | null => {
  if (!SNOWFLAKE_RE.test(value)) {
    return null
  }
  const id = BigInt(value)
  return id <= INT8_MAX ? id : null
}

const readValues = (raw: unknown): FormValues =>
  isPlainRecord(raw) ? (raw as FormValues) : {}

const readAsked = (raw: unknown): string[] =>
  Array.isArray(raw)
    ? raw.filter((v): v is string => typeof v === "string")
    : []

const readProfile = (raw: unknown): FormSessionProfile => {
  const source = isPlainRecord(raw) ? raw : {}
  return {
    known: readAsked(source.known),
    priorSubmissions:
      typeof source.priorSubmissions === "number" ? source.priorSubmissions : 0,
    limit: typeof source.limit === "number" ? source.limit : null,
  }
}

export class FormSessionService {
  /**
   * Start (or resume) a run for the contact. An `inProgress` run of the SAME
   * flow step resumes (its current question is asked again); any other run
   * is canceled first, so a contact is never inside two forms at once.
   */
  async start(input: StartFormSessionInput): Promise<FormChatAction> {
    const now = input.now ?? new Date()
    const timeoutMinutes = clampInt(
      input.timeoutMinutes,
      DEFAULT_FORM_CHAT_TIMEOUT_MINUTES,
      MAX_FORM_CHAT_TIMEOUT_MINUTES,
    )
    const maxAttempts = clampInt(
      input.maxAttempts,
      DEFAULT_FORM_CHAT_MAX_ATTEMPTS,
      MAX_FORM_CHAT_MAX_ATTEMPTS,
    )
    let step: Step
    try {
      step = await db.transaction(async (tx): Promise<Step> => {
        const form = await formService.findPublishedForChat({
          workspaceId: input.workspaceId,
          id: input.formId,
          tx,
        })
        if (!form?.publishedDefinition) {
          return { action: { kind: "unavailable", reason: "formNotFound" } }
        }
        const current = await this.lockActive(tx, input)
        if (current) {
          const sameStep =
            current.formId === input.formId &&
            current.flowId === input.flowId &&
            current.stepId === input.stepId &&
            current.conversationId === input.conversationId
          if (sameStep && current.currentFieldKey) {
            const field = this.fieldOf(current, current.currentFieldKey)
            if (field) {
              return {
                action: {
                  kind: "ask",
                  session: current,
                  field,
                  preface: [],
                  retry: false,
                },
              }
            }
          }
          await this.end(tx, current.id, "canceled", "replaced", now)
        }
        const profile = await this.profileFor(tx, {
          workspaceId: input.workspaceId,
          contactId: input.contactId,
          form,
        })
        const [session] = await tx
          .insert(formSessionModel)
          .values({
            id: createId(),
            workspaceId: input.workspaceId,
            formId: form.id,
            contactId: input.contactId,
            conversationId: input.conversationId,
            contactInboxId: input.contactInboxId,
            runStartedAt: input.runStartedAt ?? null,
            flowId: input.flowId,
            flowVersionId: input.flowVersionId,
            nodeId: input.nodeId,
            stepId: input.stepId,
            definitionVersion: form.definitionVersion,
            definition: form.publishedDefinition,
            profile,
            values: {},
            asked: [],
            maxAttempts,
            timeoutMinutes,
            expiresAt: addMinutes(now, timeoutMinutes),
          })
          .returning()
        return await this.advance(tx, session, {}, [], now)
      })
    } catch (error) {
      // Two starts racing for one contact: the partial unique index lets one
      // insert win; the loser asks nothing (the winner already asked).
      if (isUniqueViolationError(error)) {
        return { kind: "unavailable", reason: "busy" }
      }
      throw error
    }
    return await this.settle(step)
  }

  /**
   * Apply one reply to the contact's run at `stepId`. A reply is accepted
   * only when it is NEWER than the current question (message id above
   * `askMarker`, or the current `challengeId` for a picker), so a redelivered
   * message, a second reply to an answered question, or a late picker submit
   * never answers the wrong question.
   */
  async answer(input: AnswerFormSessionInput): Promise<FormChatAction> {
    const now = input.now ?? new Date()
    const step = await db.transaction(async (tx): Promise<Step> => {
      const session = await this.lockActive(tx, input)
      if (!session?.currentFieldKey) {
        return { action: { kind: "ignored", reason: "noSession" } }
      }
      if (session.stepId !== input.stepId) {
        return { action: { kind: "ignored", reason: "otherStep" } }
      }
      if (session.expiresAt.getTime() <= now.getTime()) {
        // Past its timeout: the sweep ends it and routes skip; a late reply
        // must not revive it in between.
        return { action: { kind: "ignored", reason: "expired" } }
      }
      const verdict = this.acceptReply(session, input.reply)
      if (verdict) {
        return { action: { kind: "ignored", reason: verdict } }
      }
      const field = this.fieldOf(session, session.currentFieldKey)
      if (!field) {
        // A pinned definition always holds its own current field; a row
        // that does not is corrupt: end it rather than ask forever.
        await this.end(tx, session.id, "canceled", "fieldMissing", now)
        return { action: { kind: "ignored", reason: "noSession" } }
      }
      const values = readValues(session.values)
      const asked = readAsked(session.asked)
      const messageId =
        "messageId" in input.reply ? input.reply.messageId : null
      const text =
        "messageId" in input.reply
          ? await input.reply.read(field)
          : input.reply.text
      const required = evaluateForm(
        this.definitionOf(session),
        values,
      ).requiredFields.has(field.key)

      if (typeof text === "string" && isFormChatSkip(text) && !required) {
        return await this.advance(
          tx,
          session,
          values,
          [...asked, field.key],
          now,
          messageId,
        )
      }
      const parsed = parseFormChatAnswer(field, text)
      if (!parsed.ok) {
        const attempts = session.attempts + 1
        if (attempts >= session.maxAttempts) {
          const [ended] = await tx
            .update(formSessionModel)
            .set({
              status: "skipped",
              endReason: "attempts",
              attempts,
              lastAnsweredMessageId: messageId ?? session.lastAnsweredMessageId,
              currentFieldKey: null,
              endedAt: now,
            })
            .where(eq(formSessionModel.id, session.id))
            .returning()
          return {
            action: { kind: "ended", session: ended, reason: "attempts" },
          }
        }
        const [retried] = await tx
          .update(formSessionModel)
          .set({
            attempts,
            // The retry is a new question: nothing answers it until it is
            // delivered (a second bad answer in flight is stale), and a new
            // challenge id retires the previous picker link (skeptic, s219).
            askMarker: FORM_ASK_PENDING_MARKER,
            challengeId: createId(),
            lastAnsweredMessageId: messageId ?? session.lastAnsweredMessageId,
            expiresAt: addMinutes(now, session.timeoutMinutes),
          })
          .where(eq(formSessionModel.id, session.id))
          .returning()
        return {
          action: {
            kind: "ask",
            session: retried,
            field,
            preface: [],
            retry: true,
          },
        }
      }
      return await this.advance(
        tx,
        session,
        { ...values, [field.key]: parsed.value },
        [...asked, field.key],
        now,
        messageId,
      )
    })
    return await this.settle(step)
  }

  /**
   * End every run whose question timed out, oldest first, at most `limit`.
   * `SKIP LOCKED` + the status re-check make it race an answer safely: a run
   * being answered right now is skipped this pass, and exactly one of the two
   * ends it. The returned rows keep their `challengeId`, so the caller can
   * clear the conversation challenge by compare-and-clear.
   */
  async expireDue(
    props: { now?: Date; limit?: number } = {},
  ): Promise<FormSessionModel[]> {
    const now = props.now ?? new Date()
    const limit = Math.max(1, Math.min(props.limit ?? 100, 500))
    return await db.transaction(async (tx) => {
      const due = await tx
        .select({ id: formSessionModel.id })
        .from(formSessionModel)
        .where(
          and(
            eq(formSessionModel.status, "inProgress"),
            lte(formSessionModel.expiresAt, now),
          ),
        )
        .orderBy(formSessionModel.expiresAt)
        .limit(limit)
        .for("update", { skipLocked: true })
      if (due.length === 0) {
        return []
      }
      return await tx
        .update(formSessionModel)
        .set({
          status: "expired",
          endReason: "timeout",
          endedAt: now,
          currentFieldKey: null,
        })
        .where(
          and(
            inArray(
              formSessionModel.id,
              due.map((r) => r.id),
            ),
            eq(formSessionModel.status, "inProgress"),
          ),
        )
        .returning()
    })
  }

  /** Cancel the contacts' running forms (a company stop, a flow `end`). */
  async cancelForContacts(props: {
    workspaceId: string
    contactIds: string[]
    reason: string
    now?: Date
  }): Promise<FormSessionModel[]> {
    if (props.contactIds.length === 0) {
      return []
    }
    return await db
      .update(formSessionModel)
      .set({
        status: "canceled",
        endReason: props.reason.slice(0, 100),
        endedAt: props.now ?? new Date(),
        currentFieldKey: null,
      })
      .where(
        and(
          eq(formSessionModel.workspaceId, props.workspaceId),
          inArray(formSessionModel.contactId, props.contactIds),
          eq(formSessionModel.status, "inProgress"),
        ),
      )
      .returning()
  }

  /**
   * The question was delivered: from now on a NEWER message may answer it.
   * Compare-and-set on the pending marker + challengeId, so a stale send
   * confirmation never reopens a question another reply already moved past.
   */
  async markAsked(props: {
    workspaceId: string
    sessionId: string
    challengeId: string
  }): Promise<boolean> {
    const rows = await db
      .update(formSessionModel)
      .set({ askMarker: createId() })
      .where(
        and(
          eq(formSessionModel.workspaceId, props.workspaceId),
          eq(formSessionModel.id, props.sessionId),
          eq(formSessionModel.status, "inProgress"),
          eq(formSessionModel.challengeId, props.challengeId),
          eq(formSessionModel.askMarker, FORM_ASK_PENDING_MARKER),
        ),
      )
      .returning({ id: formSessionModel.id })
    return rows.length > 0
  }

  /** One run by id, any status (no lock; the expiry re-entry checks it). */
  async findById(props: {
    workspaceId: string
    id: string
  }): Promise<FormSessionModel | undefined> {
    if (!SNOWFLAKE_RE.test(props.id)) {
      return
    }
    const [row] = await db
      .select()
      .from(formSessionModel)
      .where(
        and(
          eq(formSessionModel.workspaceId, props.workspaceId),
          eq(formSessionModel.id, props.id),
        ),
      )
      .limit(1)
    return row
  }

  /** The contact's running form, if any (no lock; for routing only). */
  async findActive(props: {
    workspaceId: string
    contactId: string
  }): Promise<FormSessionModel | undefined> {
    const [row] = await db
      .select()
      .from(formSessionModel)
      .where(
        and(
          eq(formSessionModel.workspaceId, props.workspaceId),
          eq(formSessionModel.contactId, props.contactId),
          eq(formSessionModel.status, "inProgress"),
        ),
      )
      .limit(1)
    return row
  }

  /** null = accept; otherwise why the reply is not for the current question. */
  private acceptReply(
    session: FormSessionModel,
    reply: FormChatReply,
  ): "duplicate" | "stale" | null {
    if ("challengeId" in reply) {
      return reply.challengeId === session.challengeId ? null : "stale"
    }
    if (reply.messageId === session.lastAnsweredMessageId) {
      return "duplicate"
    }
    const id = toSnowflake(reply.messageId)
    const marker = session.askMarker ? toSnowflake(session.askMarker) : null
    if (id === null || (marker !== null && id <= marker)) {
      return "stale"
    }
    return null
  }

  private async lockActive(
    tx: DatabaseClient,
    props: { workspaceId: string; contactId: string },
  ): Promise<FormSessionModel | undefined> {
    const [row] = await tx
      .select()
      .from(formSessionModel)
      .where(
        and(
          eq(formSessionModel.workspaceId, props.workspaceId),
          eq(formSessionModel.contactId, props.contactId),
          eq(formSessionModel.status, "inProgress"),
        ),
      )
      .limit(1)
      .for("update")
    return row
  }

  private definitionOf(session: FormSessionModel): FormDefinition {
    return normalizeFormDefinition(session.definition)
  }

  private fieldOf(session: FormSessionModel, key: string): FormField | null {
    return (
      formInputFields(this.definitionOf(session)).find((f) => f.key === key) ??
      null
    )
  }

  private async end(
    tx: DatabaseClient,
    id: string,
    status: "canceled" | "skipped",
    reason: string,
    now: Date,
  ): Promise<void> {
    await tx
      .update(formSessionModel)
      .set({ status, endReason: reason, endedAt: now, currentFieldKey: null })
      .where(
        and(
          eq(formSessionModel.id, id),
          eq(formSessionModel.status, "inProgress"),
        ),
      )
  }

  /** Ask the next question, or finish the run when nothing is left. */
  private async advance(
    tx: DatabaseClient,
    session: FormSessionModel,
    values: FormValues,
    asked: string[],
    now: Date,
    messageId: string | null = null,
  ): Promise<Step> {
    const def = this.definitionOf(session)
    const profile = readProfile(session.profile)
    const plan = planFormChat(def, values, new Set(asked), {
      known: new Set(profile.known),
      priorSubmissions: profile.priorSubmissions,
      limit: profile.limit,
    })
    const nextAsked = [...asked, ...plan.preface.map((f) => f.key)]
    if (!plan.next) {
      return await this.finishRun(tx, session, {
        def,
        plan,
        values,
        asked: nextAsked,
        now,
        messageId,
      })
    }
    const [updated] = await tx
      .update(formSessionModel)
      .set({
        values,
        asked: nextAsked,
        currentFieldKey: plan.next.key,
        askMarker: FORM_ASK_PENDING_MARKER,
        challengeId: createId(),
        attempts: 0,
        lastAnsweredMessageId: messageId ?? session.lastAnsweredMessageId,
        expiresAt: addMinutes(now, session.timeoutMinutes),
      })
      .where(eq(formSessionModel.id, session.id))
      .returning()
    return {
      action: {
        kind: "ask",
        session: updated,
        field: plan.next,
        preface: plan.preface,
        retry: false,
      },
    }
  }

  /** Nothing left to ask: validate, write the contact, insert the ONE submission. */
  private async finishRun(
    tx: DatabaseClient,
    session: FormSessionModel,
    run: {
      def: FormDefinition
      plan: FormChatPlan
      values: FormValues
      asked: string[]
      now: Date
      messageId: string | null
    },
  ): Promise<Step> {
    const { def, plan, values, now, messageId } = run
    const nextAsked = run.asked
    const issues = validateFormSubmission(def, values, plan.evaluation, {
      suppressed: plan.suppressed,
    })
    if (issues.length > 0) {
      // Unreachable while every asked answer passed parseFormChatAnswer and
      // the planner re-asks a newly required field; fail closed, loudly.
      logger.warn(
        { sessionId: session.id, issues },
        "form chat: finished with invalid answers; run canceled",
      )
      await this.end(tx, session.id, "canceled", "invalid", now)
      return { action: { kind: "ignored", reason: "noSession" } }
    }
    const form = await formService.get({
      workspaceId: session.workspaceId,
      id: session.formId,
      tx,
    })
    const pruned = pruneFormValues(def, values, plan.evaluation)
    const conflicts = await this.identityConflicts(tx, session, def, pruned)
    const writable: FormValues = { ...pruned }
    for (const key of conflicts) {
      delete writable[key]
    }
    const pending = await formSubmitService.writeMappedFields({
      workspaceId: session.workspaceId,
      contactId: session.contactId,
      def,
      values: writable,
      // The contact is the conversation's own: blank fields only, unless
      // the form owner opted into overwriting (the web rule, s200).
      fillBlanksOnly: !form.settings.overwriteExisting,
      tx,
    })
    const visibility: FormSubmissionVisibility = {
      steps: [...plan.evaluation.visibleSteps],
      fields: [...plan.evaluation.visibleFields],
    }
    const [submission] = await tx
      .insert(formSubmissionModel)
      .values({
        id: createId(),
        workspaceId: session.workspaceId,
        formId: session.formId,
        contactId: session.contactId,
        conversationId: session.conversationId,
        formSessionId: session.id,
        channel: "chat",
        definitionVersion: session.definitionVersion,
        values: pruned,
        visibility,
        score: formScore(def, pruned, plan.evaluation),
        identityConflict: conflicts.length > 0,
      })
      .returning()
    const [completed] = await tx
      .update(formSessionModel)
      .set({
        status: "completed",
        values,
        asked: nextAsked,
        currentFieldKey: null,
        lastAnsweredMessageId: messageId ?? session.lastAnsweredMessageId,
        endedAt: now,
      })
      .where(eq(formSessionModel.id, session.id))
      .returning()
    return {
      finished: {
        action: {
          kind: "completed",
          session: completed,
          submission,
          preface: plan.preface,
        },
        form,
        pending,
        values: pruned,
      },
    }
  }

  /** After the commit: custom-field events, tags, `formSubmitted`. */
  private async settle(step: Step): Promise<FormChatAction> {
    if ("action" in step) {
      return step.action
    }
    const { action, form, pending, values } = step.finished
    await formSubmitService.afterCommit({
      workspaceId: action.session.workspaceId,
      contactId: action.session.contactId,
      form,
      submission: action.submission,
      values,
      pending,
    })
    return action
  }

  /**
   * Mapped email / phone answers another contact already holds (Mautic's
   * unique-identifier rule, adapted): the run's contact is the
   * conversation's, so such an answer is never written to it and never
   * merges two people; the submission is flagged instead.
   */
  private async identityConflicts(
    tx: DatabaseClient,
    session: FormSessionModel,
    def: FormDefinition,
    values: FormValues,
  ): Promise<string[]> {
    const found = await formSubmitService.identityOf({
      workspaceId: session.workspaceId,
      def,
      values,
      tx,
    })
    if ("issue" in found) {
      // The phone answer passed the field check but not libphonenumber: it
      // cannot identify anyone, so it cannot conflict either.
      return []
    }
    const out: string[] = []
    const checks = [
      {
        key: found.keys.phone,
        column: contactModel.phoneNumber,
        value: found.identity.phoneNumber,
      },
      {
        key: found.keys.email,
        column: contactModel.email,
        value: found.identity.email,
      },
    ]
    for (const check of checks) {
      if (!(check.key && check.value)) {
        continue
      }
      const [other] = await tx
        .select({ id: contactModel.id })
        .from(contactModel)
        .where(
          and(
            eq(contactModel.workspaceId, session.workspaceId),
            eq(check.column, check.value),
            ne(contactModel.id, session.contactId),
          ),
        )
        .limit(1)
      if (other) {
        out.push(check.key)
      }
    }
    return out
  }

  /** Progressive-profiling inputs, fixed for the whole run. */
  private async profileFor(
    tx: DatabaseClient,
    props: { workspaceId: string; contactId: string; form: NormalizedForm },
  ): Promise<FormSessionProfile> {
    const { workspaceId, contactId, form } = props
    const def = form.publishedDefinition ?? normalizeFormDefinition(null)
    const known = new Set<string>()
    const stored = await formSubmitService.storedValues({
      workspaceId,
      contactId,
      def,
      tx,
    })
    for (const field of formInputFields(def)) {
      const target = field.mapTo
      if (
        (target?.kind === "system" && stored.system[target.key]) ||
        (target?.kind === "custom" && stored.custom.has(target.customFieldId))
      ) {
        known.add(field.key)
      }
    }
    // Mautic caps the history it reads at 200 rows (FormModel.php:396).
    const history = await tx
      .select({ values: formSubmissionModel.values })
      .from(formSubmissionModel)
      .where(
        and(
          eq(formSubmissionModel.formId, form.id),
          eq(formSubmissionModel.contactId, contactId),
        ),
      )
      .orderBy(desc(formSubmissionModel.createdAt))
      .limit(FORM_SESSION_HISTORY_CAP)
    for (const row of history) {
      for (const [key, value] of Object.entries(readValues(row.values))) {
        if (!isEmptyFormValue(value)) {
          known.add(key)
        }
      }
    }
    return {
      known: [...known],
      priorSubmissions: history.length,
      limit: form.settings.profilingLimit,
    }
  }
}

export const formSessionService = new FormSessionService()
