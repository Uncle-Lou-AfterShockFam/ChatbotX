import {
  and,
  type DatabaseClient,
  db,
  eq,
  gt,
  inArray,
  isNull,
  isUniqueViolationError,
  lte,
  ne,
  or,
  sql,
} from "@chatbotx.io/database/client"
import {
  applyHiddenDefaults,
  evaluateForm,
  type FormChatPlan,
  type FormDefinition,
  type FormField,
  type FormSessionProfile,
  type FormSubmissionVisibility,
  type FormValues,
  formInputFields,
  formScore,
  isBlockedEmailDomain,
  isEmailAnswerField,
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
import { emitFormAbandoned } from "@chatbotx.io/events"
import { createId, isPlainRecord } from "@chatbotx.io/utils"
import { logger } from "../logger"
import { formService, type NormalizedForm } from "./service"
import {
  ADMISSION_ISOLATION,
  closeFormVisits,
  FormNotAdmittedError,
  formSubmitService,
  type PendingChanges,
  retryOnLockTimeout,
} from "./submit"

/**
 * The chat run of a form (s219 A2-2): the `form` flow step asks one question
 * per message, and this service owns every state change of the run under a
 * row lock. The worker only sends what an action names and routes the flow.
 *
 * Every public method returns a typed action, never throws on a contact's
 * input: a stale, duplicate or unknown reply is `ignored`, a bad answer is a
 * retry `ask`, an exhausted question ends the run `skipped`.
 */

export { FORM_SESSION_HISTORY_CAP } from "./submit"
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
      /** start(): the run this one canceled, whose challenge must be cleared. */
      replaced?: ReplacedRun
    }
  | {
      kind: "completed"
      session: FormSessionModel
      submission: FormSubmissionModel
      preface: FormField[]
      replaced?: ReplacedRun
    }
  | { kind: "ended"; session: FormSessionModel; reason: "attempts" | "closed" }
  | { kind: "unavailable"; reason: "formNotFound" | "formClosed" | "busy" }
  | {
      kind: "ignored"
      reason:
        | "noSession"
        | "duplicate"
        | "stale"
        | "otherStep"
        | "otherConversation"
        | "expired"
    }

/** Where a canceled run was asking: its challenge still points there. */
export type ReplacedRun = {
  conversationId: string
  stepId: string
  challengeId: string | null
}

/** How far back the sweep looks for ended runs whose `formAbandoned` never went out. */
export const FORM_ABANDON_CATCHUP_MS = 24 * 60 * 60_000

/** The ends that count as the contact abandoning the run (owner, s220). */
const abandonedRun = () =>
  or(
    and(
      eq(formSessionModel.status, "expired"),
      eq(formSessionModel.endReason, "timeout"),
    ),
    and(
      eq(formSessionModel.status, "skipped"),
      eq(formSessionModel.endReason, "attempts"),
    ),
  )

/** A question still pending delivery this long is re-asked on the next reply. */
export const FORM_UNDELIVERED_REASK_MS = 2 * 60_000

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
  /** The conversation and channel identity the reply arrived on; must be the run's own. */
  conversationId: string
  contactInboxId: string
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
    let replaced: ReplacedRun | undefined
    try {
      step = await retryOnLockTimeout(() =>
        db.transaction(async (tx): Promise<Step> => {
          const form = await formService.findPublishedForChat({
            workspaceId: input.workspaceId,
            id: input.formId,
            tx,
          })
          if (!form?.publishedDefinition) {
            return { action: { kind: "unavailable", reason: "formNotFound" } }
          }
          // s220c A2-4: outside its window or full, the step takes its skip
          // edge before a question is asked (the finish re-checks the limit).
          if ((await formSubmitService.availability(form, now, tx)) !== null) {
            return { action: { kind: "unavailable", reason: "formClosed" } }
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
            replaced = {
              conversationId: current.conversationId,
              stepId: current.stepId,
              challengeId: current.challengeId,
            }
          }
          const profile = await formSubmitService.contactProfile({
            tx,
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
          return await this.advance(
            tx,
            session,
            // hidden fields are never asked: their defaults are the run's
            // starting values (the answer path re-applies them per reply)
            applyHiddenDefaults(this.definitionOf(session), {}),
            [],
            now,
          )
        }, ADMISSION_ISOLATION),
      )
    } catch (error) {
      // Two starts racing for one contact: the partial unique index lets one
      // insert win; the loser asks nothing (the winner already asked).
      if (isUniqueViolationError(error)) {
        return { kind: "unavailable", reason: "busy" }
      }
      throw error
    }
    if (replaced) {
      if ("finished" in step) {
        step.finished.action.replaced = replaced
      } else if (step.action.kind === "ask") {
        step.action.replaced = replaced
      }
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
    const step = await retryOnLockTimeout(() =>
      db.transaction(async (tx): Promise<Step> => {
        const session = await this.lockActive(tx, input)
        if (!session?.currentFieldKey) {
          return { action: { kind: "ignored", reason: "noSession" } }
        }
        if (session.stepId !== input.stepId) {
          return { action: { kind: "ignored", reason: "otherStep" } }
        }
        if (
          session.conversationId !== input.conversationId ||
          session.contactInboxId !== input.contactInboxId
        ) {
          // Asked on one channel, answered on another (a merged contact): the
          // reply never saw this question's buttons or numbering (skeptic).
          return { action: { kind: "ignored", reason: "otherConversation" } }
        }
        if (session.expiresAt.getTime() <= now.getTime()) {
          // Past its timeout: the sweep ends it and routes skip; a late reply
          // must not revive it in between.
          return { action: { kind: "ignored", reason: "expired" } }
        }
        const verdict = this.acceptReply(session, input.reply)
        if (
          verdict === "stale" &&
          session.askMarker === FORM_ASK_PENDING_MARKER &&
          now.getTime() - session.updatedAt.getTime() >
            FORM_UNDELIVERED_REASK_MS
        ) {
          // The worker never confirmed this question (it died mid-send): the
          // contact is replying to nothing, so ask it again rather than wait
          // out the whole timeout (blind probe, s219 A2-2).
          const field = this.fieldOf(session, session.currentFieldKey)
          if (field) {
            return {
              action: {
                kind: "ask",
                session,
                field,
                preface: [],
                retry: false,
              },
            }
          }
        }
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
        // Hidden defaults before the required check too: a rule may read them.
        const values = applyHiddenDefaults(
          this.definitionOf(session),
          readValues(session.values),
        )
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
        const parsed = await this.parseAnswer(tx, session, field, text)
        if (!parsed.ok) {
          const attempts = session.attempts + 1
          if (attempts >= session.maxAttempts) {
            const [ended] = await tx
              .update(formSessionModel)
              .set({
                status: "skipped",
                endReason: "attempts",
                attempts,
                lastAnsweredMessageId:
                  messageId ?? session.lastAnsweredMessageId,
                currentFieldKey: null,
                lastFieldKey: session.currentFieldKey,
                endedAt: now,
              })
              .where(
                and(
                  eq(formSessionModel.id, session.id),
                  eq(formSessionModel.status, "inProgress"),
                ),
              )
              .returning()
            if (!ended) {
              return { action: { kind: "ignored", reason: "noSession" } }
            }
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
      }, ADMISSION_ISOLATION),
    )
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
          endReason: sql`coalesce(${formSessionModel.endReason}, 'timeout')`,
          endedAt: now,
          // SET reads the OLD row, so this keeps the question it timed out on.
          lastFieldKey: sql`${formSessionModel.currentFieldKey}`,
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
        lastFieldKey: sql`${formSessionModel.currentFieldKey}`,
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

  /**
   * The current question was NOT delivered (the send failed, timed out or
   * threw): the contact cannot answer it, so the run is due now and the next
   * sweep ends it down the skip path instead of after the full timeout.
   * Conditional on the question still pending, like markAsked.
   */
  async markUndelivered(props: {
    workspaceId: string
    sessionId: string
    challengeId: string
    now?: Date
  }): Promise<boolean> {
    const rows = await db
      .update(formSessionModel)
      .set({ expiresAt: props.now ?? new Date(), endReason: "undelivered" })
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

  /**
   * Emit `formAbandoned` for a run the contact left (s220 A2-3), at most once:
   * the `abandonEmittedAt` compare-and-set is the claim, taken BEFORE the
   * emit, so two sweeps or a sweep and the answer path never both emit. Only
   * a timeout or used-up attempts qualify; a canceled, replaced or
   * undelivered run is not the contact's doing. An emit that fails after the
   * claim is logged and lost, the same guarantee `formSubmitted` has.
   */
  async emitAbandoned(
    row: Pick<FormSessionModel, "id" | "workspaceId">,
    now: Date = new Date(),
  ): Promise<boolean> {
    const [claimed] = await db
      .update(formSessionModel)
      .set({ abandonEmittedAt: now })
      .where(
        and(
          eq(formSessionModel.workspaceId, row.workspaceId),
          eq(formSessionModel.id, row.id),
          isNull(formSessionModel.abandonEmittedAt),
          abandonedRun(),
        ),
      )
      .returning()
    if (!claimed) {
      return false
    }
    await emitFormAbandoned(claimed.workspaceId, claimed.contactId, {
      formId: claimed.formId,
      formSessionId: claimed.id,
      channel: "chat",
      reason: claimed.endReason === "attempts" ? "attempts" : "timeout",
      lastFieldKey: claimed.lastFieldKey ?? null,
      askedCount: readAsked(claimed.asked).length,
      conversationId: claimed.conversationId,
      flowId: claimed.flowId,
      occurredAt: (claimed.endedAt ?? now).toISOString(),
    }).catch((error: unknown) =>
      logger.warn(
        { err: error, formSessionId: claimed.id },
        "form session: formAbandoned event failed after claim",
      ),
    )
    return true
  }

  /**
   * Catch-up for runs that ended but were never claimed (the process died
   * between the end and the emit): abandoned runs that ended within the last
   * `FORM_ABANDON_CATCHUP_MS`, oldest first, at most `limit`. Older ones are
   * given up ON PURPOSE (a day-late "you left the form" would reach a contact
   * who moved on): stamped without an event and logged once, so nothing sits
   * unclaimed silently (skeptic, s220 A2-3).
   */
  async emitPendingAbandons(
    props: { now?: Date; limit?: number } = {},
  ): Promise<number> {
    const now = props.now ?? new Date()
    const limit = Math.max(1, Math.min(props.limit ?? 100, 500))
    const cutoff = new Date(now.getTime() - FORM_ABANDON_CATCHUP_MS)
    const aged = await db
      .select({ id: formSessionModel.id })
      .from(formSessionModel)
      .where(
        and(
          isNull(formSessionModel.abandonEmittedAt),
          abandonedRun(),
          lte(formSessionModel.endedAt, cutoff),
        ),
      )
      .limit(limit)
    if (aged.length > 0) {
      const givenUp = await db
        .update(formSessionModel)
        .set({ abandonEmittedAt: now })
        .where(
          and(
            inArray(
              formSessionModel.id,
              aged.map((r) => r.id),
            ),
            isNull(formSessionModel.abandonEmittedAt),
          ),
        )
        .returning({ id: formSessionModel.id })
      if (givenUp.length > 0) {
        logger.warn(
          { formSessionIds: givenUp.map((r) => r.id) },
          "form session: formAbandoned never went out within the catch-up window; given up",
        )
      }
    }
    const rows = await db
      .select({
        id: formSessionModel.id,
        workspaceId: formSessionModel.workspaceId,
      })
      .from(formSessionModel)
      .where(
        and(
          isNull(formSessionModel.abandonEmittedAt),
          abandonedRun(),
          gt(formSessionModel.endedAt, cutoff),
        ),
      )
      .orderBy(formSessionModel.endedAt)
      .limit(limit)
    let emitted = 0
    for (const row of rows) {
      if (await this.emitAbandoned(row, now)) {
        emitted++
      }
    }
    return emitted
  }

  /**
   * Claim the ONE skip routing of an expired run. Refused when it was routed
   * already (a flow that loops back to the step must start a fresh run, not
   * skip again) or when the contact has a newer run in progress (routing the
   * old run's skip then would give one flow both skip and success).
   */
  async claimExpiredRoute(props: {
    workspaceId: string
    sessionId: string
    contactId: string
    conversationId: string
    stepId: string
    now?: Date
  }): Promise<boolean> {
    const active = await this.findActive(props)
    if (active) {
      return false
    }
    const rows = await db
      .update(formSessionModel)
      .set({ routedAt: props.now ?? new Date() })
      .where(
        and(
          eq(formSessionModel.workspaceId, props.workspaceId),
          eq(formSessionModel.id, props.sessionId),
          eq(formSessionModel.status, "expired"),
          eq(formSessionModel.conversationId, props.conversationId),
          eq(formSessionModel.stepId, props.stepId),
          isNull(formSessionModel.routedAt),
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

  /**
   * One chat reply as an answer to `field`; an email on one of the form's
   * blocked domains is refused like any bad answer (s220c A2-4). The live
   * settings are read only for an email question.
   */
  private async parseAnswer(
    tx: DatabaseClient,
    session: FormSessionModel,
    field: FormField,
    text: unknown,
  ): Promise<ReturnType<typeof parseFormChatAnswer>> {
    const parsed = parseFormChatAnswer(field, text)
    if (!(parsed.ok && isEmailAnswerField(field))) {
      return parsed
    }
    const form = await formService.get({
      workspaceId: session.workspaceId,
      id: session.formId,
      tx,
    })
    return isBlockedEmailDomain(
      parsed.value,
      form.settings.blockedEmailDomains ?? [],
    )
      ? { ok: false, code: "emailDomainBlocked" }
      : parsed
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
      .set({
        status,
        endReason: reason,
        endedAt: now,
        lastFieldKey: sql`${formSessionModel.currentFieldKey}`,
        currentFieldKey: null,
      })
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
    const visibility: FormSubmissionVisibility = {
      steps: [...plan.evaluation.visibleSteps],
      fields: [...plan.evaluation.visibleFields],
    }
    // s220c A2-4: the contact writes, the admission (the per-form lock of
    // the web submit, re-checking the window AND the limit) and the insert
    // run in one savepoint: a form that closed or filled up mid-run rolls
    // the writes back and ends the run on its skip edge (`closed`, never a
    // formAbandoned).
    let stored: { submission: FormSubmissionModel; pending: PendingChanges }
    try {
      stored = await tx.transaction(async (sp) => {
        const pending = await formSubmitService.writeMappedFields({
          workspaceId: session.workspaceId,
          contactId: session.contactId,
          def,
          values: writable,
          // The contact is the conversation's own: blank fields only, unless
          // the form owner opted into overwriting (the web rule, s200).
          fillBlanksOnly: !form.settings.overwriteExisting,
          tx: sp,
        })
        const refused = await formSubmitService.admit(sp, form.id)
        if (refused !== null) {
          throw new FormNotAdmittedError(refused)
        }
        const [submission] = await sp
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
        // Answered in chat: an open web visit of the same form is done too.
        await closeFormVisits(sp, {
          formId: session.formId,
          contactId: session.contactId,
          now,
        })
        return { submission, pending }
      })
    } catch (error) {
      if (!(error instanceof FormNotAdmittedError)) {
        throw error
      }
      const [ended] = await tx
        .update(formSessionModel)
        .set({
          status: "skipped",
          endReason: "closed",
          currentFieldKey: null,
          lastFieldKey: session.currentFieldKey,
          endedAt: now,
        })
        .where(
          and(
            eq(formSessionModel.id, session.id),
            eq(formSessionModel.status, "inProgress"),
          ),
        )
        .returning()
      return ended
        ? { action: { kind: "ended", session: ended, reason: "closed" } }
        : { action: { kind: "ignored", reason: "noSession" } }
    }
    const { submission, pending } = stored
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
      if (step.action.kind === "ended") {
        await this.emitAbandoned(step.action.session)
      }
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
}

export const formSessionService = new FormSessionService()
