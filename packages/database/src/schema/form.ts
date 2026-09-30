import { sql } from "drizzle-orm"
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import type {
  FormChannel,
  FormDefinition,
  FormSessionProfile,
  FormSessionStatus,
  FormSettings,
  FormStatus,
  FormSubmissionVisibility,
} from "../partials/form"
import {
  formChannels,
  formSessionStatuses,
  formStatuses,
} from "../partials/form"
import {
  bigintAsString,
  sharedColumns,
  timestampConfig,
} from "../partials/shared"
import { userModel } from "./auth-user"
import { contactModel } from "./contact"
import { contactInboxModel } from "./contact-inbox"
import { conversationModel } from "./conversation"
import { flowModel } from "./flow"
import { inboxModel } from "./inbox"
import { workspaceModel } from "./workspace"

export const formStatus = pgEnum(
  "formStatus",
  formStatuses.options as [FormStatus, ...FormStatus[]],
)

export const formChannel = pgEnum(
  "formChannel",
  formChannels.options as [FormChannel, ...FormChannel[]],
)

export const formSessionStatus = pgEnum(
  "formSessionStatus",
  formSessionStatuses.options as [FormSessionStatus, ...FormSessionStatus[]],
)

/**
 * A web form (s200): `definition` is the DRAFT the editor saves;
 * `publishedDefinition` is what the public page serves and the submit route
 * validates against, copied on publish with `definitionVersion + 1`. Both
 * jsonb columns are written explicitly on every insert (no drizzle
 * `.default()`: AGENTS.md, a jsonb default is not a database default).
 * `inboxId` names the API-channel inbox a submission's contact is attached
 * to; required as soon as any field maps to a contact.
 */
export const formModel = pgTable(
  "Form",
  {
    ...sharedColumns,
    title: text().notNull(),
    slug: text().notNull(),
    status: formStatus().notNull().default("draft"),
    definition: jsonb().$type<FormDefinition>().notNull(),
    publishedDefinition: jsonb().$type<FormDefinition>(),
    definitionVersion: integer().notNull().default(0),
    settings: jsonb().$type<FormSettings>().notNull(),
    publishedAt: timestamp(timestampConfig),
    workspaceId: bigintAsString()
      .notNull()
      .references(() => workspaceModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    inboxId: bigintAsString().references(() => inboxModel.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    createdById: bigintAsString().references(() => userModel.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
  },
  (table) => [
    uniqueIndex("Form_workspaceId_slug_key").on(table.workspaceId, table.slug),
    index("Form_workspaceId_status_idx").on(table.workspaceId, table.status),
  ],
)

/**
 * One submission: `values` keyed by field key (only visible, non-blank
 * answers), `visibility` = the step / field ids visible at answer time, so a
 * row stays readable after the form changes. `dedupHash` (form + canonical
 * values + ipHash) folds an identical resubmit within the dedup window.
 *
 * A chat submission (s219 A2-2) has no ip: `ipHash` / `dedupHash` are web
 * only (the check keeps a web row from losing them), and `formSessionId` is
 * UNIQUE, so a retried finish can never insert twice.
 */
export const formSubmissionModel = pgTable(
  "FormSubmission",
  {
    ...sharedColumns,
    definitionVersion: integer().notNull(),
    values: jsonb().$type<Record<string, unknown>>().notNull(),
    visibility: jsonb().$type<FormSubmissionVisibility>().notNull(),
    channel: formChannel().notNull().default("web"),
    ipHash: text(),
    userAgent: text(),
    dedupHash: text(),
    score: integer(),
    /** A mapped email / phone answer belongs to another contact: not written. */
    identityConflict: boolean().notNull().default(false),
    workspaceId: bigintAsString()
      .notNull()
      .references(() => workspaceModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    formId: bigintAsString()
      .notNull()
      .references(() => formModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    contactId: bigintAsString().references(() => contactModel.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    conversationId: bigintAsString().references(() => conversationModel.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    formSessionId: bigintAsString().references(() => formSessionModel.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
  },
  (table) => [
    check(
      "FormSubmission_web_hashes_check",
      sql`${table.channel} <> 'web' OR (${table.ipHash} IS NOT NULL AND ${table.dedupHash} IS NOT NULL)`,
    ),
    uniqueIndex("FormSubmission_formSessionId_key").on(table.formSessionId),
    index("FormSubmission_formId_createdAt_idx").on(
      table.formId,
      table.createdAt,
    ),
    index("FormSubmission_formId_dedupHash_createdAt_idx").on(
      table.formId,
      table.dedupHash,
      table.createdAt,
    ),
    index("FormSubmission_formId_ipHash_createdAt_idx").on(
      table.formId,
      table.ipHash,
      table.createdAt,
    ),
    index("FormSubmission_workspaceId_contactId_idx").on(
      table.workspaceId,
      table.contactId,
    ),
  ],
)

/**
 * One chat run of a published form (s219 A2-2): the flow step asks one
 * question per message and this row is the only state. It pins the
 * definition it started with, so a republish mid-conversation cannot change
 * the questions under a contact.
 *
 * Concurrency: every answer locks the row (`FOR UPDATE`) and is accepted only
 * when the reply's message id is newer than `askMarker` (a snowflake minted
 * when the current question was asked; insertion order, never the channel's
 * own timestamp, which can be minute-granular), so a duplicate delivery or a
 * reply racing the next question is a no-op. `challengeId` names the current
 * question in the conversation challenge. At most one `inProgress` row per
 * contact (partial unique index).
 */
export const formSessionModel = pgTable(
  "FormSession",
  {
    ...sharedColumns,
    workspaceId: bigintAsString()
      .notNull()
      .references(() => workspaceModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    formId: bigintAsString()
      .notNull()
      .references(() => formModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    contactId: bigintAsString()
      .notNull()
      .references(() => contactModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    conversationId: bigintAsString()
      .notNull()
      .references(() => conversationModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    /** The channel identity the run asks on (the sweep re-enters the flow with it). */
    contactInboxId: bigintAsString()
      .notNull()
      .references(() => contactInboxModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    flowId: bigintAsString()
      .notNull()
      .references(() => flowModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    flowVersionId: bigintAsString(),
    /** When the flow run that started this form began (company-stop guard). */
    runStartedAt: timestamp(timestampConfig),
    nodeId: text().notNull(),
    stepId: text().notNull(),
    status: formSessionStatus().notNull().default("inProgress"),
    endReason: text(),
    definitionVersion: integer().notNull(),
    definition: jsonb().$type<FormDefinition>().notNull(),
    profile: jsonb().$type<FormSessionProfile>().notNull(),
    values: jsonb().$type<Record<string, unknown>>().notNull(),
    /** Every key already sent: answered, skipped-optional, or a display block. */
    asked: jsonb().$type<string[]>().notNull(),
    currentFieldKey: text(),
    askMarker: bigintAsString(),
    challengeId: text(),
    attempts: integer().notNull().default(0),
    maxAttempts: integer().notNull(),
    timeoutMinutes: integer().notNull(),
    lastAnsweredMessageId: bigintAsString(),
    expiresAt: timestamp(timestampConfig).notNull(),
    endedAt: timestamp(timestampConfig),
    /** When an expired run's flow was routed down skip (at most once). */
    routedAt: timestamp(timestampConfig),
    /** The question the run was on when it ended (`currentFieldKey` is cleared). */
    lastFieldKey: text(),
    /** When `formAbandoned` was claimed for this run (at most once, s220 A2-3). */
    abandonEmittedAt: timestamp(timestampConfig),
  },
  (table) => [
    uniqueIndex("FormSession_contactId_inProgress_key")
      .on(table.contactId)
      .where(sql`${table.status} = 'inProgress'`),
    index("FormSession_expiresAt_inProgress_idx")
      .on(table.expiresAt)
      .where(sql`${table.status} = 'inProgress'`),
    index("FormSession_endedAt_abandonPending_idx")
      .on(table.endedAt)
      .where(
        sql`${table.status} in ('expired', 'skipped') and ${table.abandonEmittedAt} is null`,
      ),
    index("FormSession_workspaceId_formId_idx").on(
      table.workspaceId,
      table.formId,
    ),
    // Contact-filter `formStarted` probes sessions of any status (s226a).
    index("FormSession_workspaceId_contactId_idx").on(
      table.workspaceId,
      table.contactId,
    ),
  ],
)

/**
 * One web visit of a published form by a contact a PERSONAL form link names
 * (s224a A2-4): the page's first interaction opens it, a submit closes it
 * (`submittedAt`), and the sweep closes the rest at `abandonAt` with
 * `formAbandoned` (channel web; the `abandonEmittedAt` compare-and-set is
 * the claim). An anonymous visitor never has one. At most one OPEN visit per
 * (form, contact): a later beacon refreshes it instead of adding a row.
 * `interactionId` is the page load's own id, sent with its beacon AND its
 * submit: a submit that lands first leaves a closed row under that id, so
 * the late beacon finds it and opens nothing (Codex probe s224a).
 */
export const formVisitModel = pgTable(
  "FormVisit",
  {
    ...sharedColumns,
    workspaceId: bigintAsString()
      .notNull()
      .references(() => workspaceModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    formId: bigintAsString()
      .notNull()
      .references(() => formModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    contactId: bigintAsString()
      .notNull()
      .references(() => contactModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    interactionId: text().notNull(),
    startedAt: timestamp(timestampConfig).notNull(),
    lastActivityAt: timestamp(timestampConfig).notNull(),
    /** lastActivityAt + the form's abandonAfterMinutes at that beacon. */
    abandonAt: timestamp(timestampConfig).notNull(),
    submittedAt: timestamp(timestampConfig),
    abandonEmittedAt: timestamp(timestampConfig),
  },
  (table) => [
    uniqueIndex("FormVisit_formId_contactId_open_key")
      .on(table.formId, table.contactId)
      .where(
        sql`${table.submittedAt} is null and ${table.abandonEmittedAt} is null`,
      ),
    uniqueIndex("FormVisit_formId_contactId_interactionId_key").on(
      table.formId,
      table.contactId,
      table.interactionId,
    ),
    index("FormVisit_abandonAt_open_idx")
      .on(table.abandonAt)
      .where(
        sql`${table.submittedAt} is null and ${table.abandonEmittedAt} is null`,
      ),
    index("FormVisit_createdAt_closed_idx")
      .on(table.createdAt)
      .where(
        sql`${table.submittedAt} is not null or ${table.abandonEmittedAt} is not null`,
      ),
    index("FormVisit_contactId_idx").on(table.contactId),
  ],
)

/**
 * One private web upload for a form's `image` / `file` field (s225a A2-4
 * PR 5). The upload route writes the row, THEN the object at `path`
 * (`workspaces/<ws>/forms/<formId>/<uuid>`, never under `public/`); the
 * field's value is the opaque `uploadId`. A submit claims its uploads by
 * setting `submissionId` (conditional on NULL, so exactly one submission
 * owns a row). `deletingAt` is the durable cleanup mark: set (and
 * committed) BEFORE its object is deleted, never claimable again, and the
 * row goes only once the store confirmed the delete; the sweep marks the
 * unclaimed rows past their age, a submission delete detaches and marks its
 * own. `interactionId` binds the upload to the page load that sent it:
 * another page (or a replayed id) cannot claim it. `mimeType` is the
 * sniffed type, never the client's.
 */
export const formUploadModel = pgTable(
  "FormUpload",
  {
    ...sharedColumns,
    uploadId: text().notNull(),
    workspaceId: bigintAsString()
      .notNull()
      .references(() => workspaceModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    formId: bigintAsString()
      .notNull()
      .references(() => formModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    submissionId: bigintAsString().references(() => formSubmissionModel.id, {
      onDelete: "cascade",
      onUpdate: "cascade",
    }),
    fieldKey: text().notNull(),
    interactionId: text().notNull(),
    path: text().notNull(),
    mimeType: text().notNull(),
    sizeBytes: integer().notNull(),
    fileName: text().notNull(),
    ipHash: text().notNull(),
    deletingAt: timestamp(timestampConfig),
  },
  (table) => [
    uniqueIndex("FormUpload_uploadId_key").on(table.uploadId),
    uniqueIndex("FormUpload_path_key").on(table.path),
    index("FormUpload_cleanup_pending_idx")
      .on(sql`coalesce(${table.deletingAt}, ${table.createdAt})`)
      .where(sql`${table.submissionId} is null`),
    index("FormUpload_formId_ipHash_createdAt_idx").on(
      table.formId,
      table.ipHash,
      table.createdAt,
    ),
    index("FormUpload_submissionId_idx").on(table.submissionId),
  ],
)
