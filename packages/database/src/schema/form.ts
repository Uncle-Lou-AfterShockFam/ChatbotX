import {
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
  FormDefinition,
  FormSettings,
  FormStatus,
  FormSubmissionVisibility,
} from "../partials/form"
import { formStatuses } from "../partials/form"
import {
  bigintAsString,
  sharedColumns,
  timestampConfig,
} from "../partials/shared"
import { userModel } from "./auth-user"
import { contactModel } from "./contact"
import { inboxModel } from "./inbox"
import { workspaceModel } from "./workspace"

export const formStatus = pgEnum(
  "formStatus",
  formStatuses.options as [FormStatus, ...FormStatus[]],
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
 */
export const formSubmissionModel = pgTable(
  "FormSubmission",
  {
    ...sharedColumns,
    definitionVersion: integer().notNull(),
    values: jsonb().$type<Record<string, unknown>>().notNull(),
    visibility: jsonb().$type<FormSubmissionVisibility>().notNull(),
    ipHash: text().notNull(),
    userAgent: text(),
    dedupHash: text().notNull(),
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
  },
  (table) => [
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
