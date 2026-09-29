import {
  and,
  db,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  notExists,
  or,
  sql,
} from "@chatbotx.io/database/client"
import { FORM_MAX_ABANDON_MINUTES } from "@chatbotx.io/database/partials"
import { formModel, formVisitModel } from "@chatbotx.io/database/schema"
import type { FormVisitModel } from "@chatbotx.io/database/types"
import { emitFormAbandoned } from "@chatbotx.io/events"
import { createId } from "@chatbotx.io/utils"
import { alias } from "drizzle-orm/pg-core"
import { logger } from "../logger"
import { formService, type NormalizedForm } from "./service"
import { FORM_ABANDON_CATCHUP_MS } from "./session"
import { formSubmitService } from "./submit"

/**
 * Web `formAbandoned` (s224a A2-4, owner: signed links only). A visitor a
 * PERSONAL form link names opens a visit on their first interaction with
 * the page (`start`); a submit on any channel closes it (`closeFormVisits`
 * in the submit / chat-finish transaction); the schedule sweep closes the
 * rest once idle past the form's `abandonAfterMinutes` and emits the event
 * (`emitDueAbandons`). An anonymous visitor writes nothing: there is no
 * contact to name, and an open beacon must not be a storage sink.
 */

/** Closed visits are kept this long for support, then pruned by the sweep. */
export const FORM_VISIT_RETENTION_MS = 30 * 24 * 60 * 60_000

/** The same table under another name, for the interaction lookup. */
const interaction = alias(formVisitModel, "interaction")

const openVisit = () =>
  and(
    isNull(formVisitModel.submittedAt),
    isNull(formVisitModel.abandonEmittedAt),
  )

export type StartFormVisitResult =
  | { kind: "started" }
  | { kind: "ignored"; reason: "noLink" | "closed" }

export class FormVisitService {
  /**
   * Open (or refresh) the linked contact's visit of a published web form,
   * for one page load (`interactionId`). Ignored, writing nothing, unless
   * the token names a contact that still exists for THIS workspace + form
   * and the form takes submissions now. One statement, two outcomes:
   * - a new interaction inserts its row, unless the contact already has an
   *   OPEN visit of the form (another tab, a reload): that one is refreshed;
   * - a known interaction (a replayed beacon, or one that arrived after its
   *   own submit) changes nothing, so it can never reopen a finished visit.
   */
  async start(props: {
    form: Pick<NormalizedForm, "id" | "workspaceId" | "settings">
    formLinkToken: string | undefined
    interactionId: string
    now?: Date
  }): Promise<StartFormVisitResult> {
    const now = props.now ?? new Date()
    const { form } = props
    const contactId = await formSubmitService.linkedContact(
      {
        workspaceId: form.workspaceId,
        formLinkToken: props.formLinkToken,
      },
      form.id,
    )
    if (contactId === null) {
      return { kind: "ignored", reason: "noLink" }
    }
    if ((await formSubmitService.availability(form, now)) !== null) {
      return { kind: "ignored", reason: "closed" }
    }
    const abandonAt = new Date(
      now.getTime() + form.settings.abandonAfterMinutes * 60_000,
    )
    const inserted = await db
      .insert(formVisitModel)
      .values({
        id: createId(),
        workspaceId: form.workspaceId,
        formId: form.id,
        contactId,
        interactionId: props.interactionId,
        startedAt: now,
        lastActivityAt: now,
        abandonAt,
      })
      // Either unique index: the interaction exists, or an open visit does.
      .onConflictDoNothing()
      .returning({ id: formVisitModel.id })
    if (inserted.length === 0) {
      await db
        .update(formVisitModel)
        // Refreshes never push past FORM_MAX_ABANDON_MINUTES from the first
        // interaction: repeated beacons cannot hold an abandon off forever
        // (skeptic s224a).
        .set({
          lastActivityAt: now,
          abandonAt: sql`least(${abandonAt}, ${formVisitModel.startedAt} + make_interval(mins => ${FORM_MAX_ABANDON_MINUTES}))`,
        })
        .where(
          and(
            eq(formVisitModel.formId, form.id),
            eq(formVisitModel.contactId, contactId),
            openVisit(),
            notExists(
              db
                .select({ one: sql`1` })
                .from(interaction)
                .where(
                  and(
                    eq(interaction.formId, form.id),
                    eq(interaction.contactId, contactId),
                    eq(interaction.interactionId, props.interactionId),
                  ),
                ),
            ),
          ),
        )
    }
    return { kind: "started" }
  }

  /**
   * Close every visit idle past its `abandonAt`, oldest first, at most
   * `limit`, and emit `formAbandoned` for each. The `abandonEmittedAt`
   * stamp is the claim, taken under `SKIP LOCKED` BEFORE any emit, so two
   * sweeps never both emit and a submit racing the claim either closed the
   * row first (no event) or finds it closed (its own submission stands).
   * An emit that fails after the claim is logged and lost, the same
   * at-most-once guarantee as chat. A visit whose form no longer runs on
   * the web, or that is older than `FORM_ABANDON_CATCHUP_MS` past due (the
   * worker was down), is closed WITHOUT an event.
   */
  async emitDueAbandons(
    props: { now?: Date; limit?: number } = {},
  ): Promise<{ claimed: number; emitted: number }> {
    const now = props.now ?? new Date()
    const limit = Math.max(1, Math.min(props.limit ?? 100, 500))
    const claimed = await db.transaction(async (tx) => {
      const due = await tx
        .select({ id: formVisitModel.id })
        .from(formVisitModel)
        .where(and(openVisit(), lte(formVisitModel.abandonAt, now)))
        .orderBy(formVisitModel.abandonAt)
        .limit(limit)
        .for("update", { skipLocked: true })
      if (due.length === 0) {
        return []
      }
      return await tx
        .update(formVisitModel)
        .set({ abandonEmittedAt: now })
        .where(
          and(
            inArray(
              formVisitModel.id,
              due.map((r) => r.id),
            ),
            openVisit(),
          ),
        )
        .returning()
    })
    let emitted = 0
    const cutoff = now.getTime() - FORM_ABANDON_CATCHUP_MS
    const givenUp: string[] = []
    for (const visit of claimed) {
      if (visit.abandonAt.getTime() < cutoff) {
        givenUp.push(visit.id)
        continue
      }
      if (await this.emitAbandoned(visit)) {
        emitted++
      }
    }
    if (givenUp.length > 0) {
      logger.warn(
        { formVisitIds: givenUp },
        "form visit: formAbandoned past the catch-up window; closed without an event",
      )
    }
    return { claimed: claimed.length, emitted }
  }

  /** Emit for one claimed visit, if its form still runs on the web. */
  private async emitAbandoned(visit: FormVisitModel): Promise<boolean> {
    const [row] = await db
      .select()
      .from(formModel)
      .where(
        and(
          eq(formModel.id, visit.formId),
          eq(formModel.workspaceId, visit.workspaceId),
          eq(formModel.status, "published"),
        ),
      )
      .limit(1)
    if (
      !(row && formService.normalize(row).settings.channels.includes("web"))
    ) {
      return false
    }
    try {
      await emitFormAbandoned(visit.workspaceId, visit.contactId, {
        formId: visit.formId,
        formVisitId: visit.id,
        channel: "web",
        reason: "timeout",
        lastFieldKey: null,
        askedCount: 0,
        occurredAt: visit.abandonAt.toISOString(),
      })
      return true
    } catch (error) {
      logger.warn(
        { err: error, formVisitId: visit.id },
        "form visit: formAbandoned event failed after claim",
      )
      return false
    }
  }

  /** Delete closed visits past retention, at most `limit` per call. */
  async pruneClosed(
    props: { now?: Date; limit?: number } = {},
  ): Promise<number> {
    const now = props.now ?? new Date()
    const limit = Math.max(1, Math.min(props.limit ?? 500, 5000))
    const before = new Date(now.getTime() - FORM_VISIT_RETENTION_MS)
    const doomed = db
      .select({ id: formVisitModel.id })
      .from(formVisitModel)
      .where(
        and(
          lt(formVisitModel.createdAt, before),
          or(
            isNotNull(formVisitModel.submittedAt),
            isNotNull(formVisitModel.abandonEmittedAt),
          ),
        ),
      )
      .limit(limit)
    const rows = await db
      .delete(formVisitModel)
      .where(inArray(formVisitModel.id, doomed))
      .returning({ id: formVisitModel.id })
    return rows.length
  }
}

export const formVisitService = new FormVisitService()
