import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import {
  type ContactDocumentStatus,
  contactDocumentStatuses,
  type DocumentTemplateStatus,
  documentTemplateStatuses,
} from "../partials/document"
import {
  bigintAsString,
  sharedColumns,
  timestampConfig,
} from "../partials/shared"
import { userModel } from "./auth-user"
import { contactModel } from "./contact"
import { workspaceModel } from "./workspace"

export const documentTemplateStatus = pgEnum(
  "documentTemplateStatus",
  documentTemplateStatuses.options as [
    DocumentTemplateStatus,
    ...DocumentTemplateStatus[],
  ],
)

export const contactDocumentStatus = pgEnum(
  "contactDocumentStatus",
  contactDocumentStatuses.options as [
    ContactDocumentStatus,
    ...ContactDocumentStatus[],
  ],
)

/**
 * A document template (roadmap B3): HTML from the builder's editor with
 * `{{variable}}` merge fields (contact system + custom fields). A
 * `{{signature, r1}}` / `{{date, r1}}` text is NOT a merge field: it is a
 * Documenso placeholder the signing step turns into a signature field, so the
 * renderer refuses merge VALUES that contain `{{` or `}}`.
 */
export const documentTemplateModel = pgTable(
  "DocumentTemplate",
  {
    ...sharedColumns,
    name: text().notNull(),
    bodyHtml: text().notNull(),
    status: documentTemplateStatus().notNull().default("active"),
    workspaceId: bigintAsString()
      .notNull()
      .references(() => workspaceModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    createdById: bigintAsString().references(() => userModel.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
  },
  (table) => [
    index("DocumentTemplate_workspaceId_status_idx").on(
      table.workspaceId,
      table.status,
    ),
  ],
)

/**
 * One rendered document on one contact: a private PDF in object storage
 * (`path`, never under `public/`) reached through the unauthenticated
 * `/f/<token>` route until `tokenExpiresAt`. `(contactId, ref)` is the
 * idempotency key: a flow retry or API retry with the same ref returns the
 * same row instead of rendering again. `templateId` is kept as history
 * (set null when the template is deleted); `title` is the name at render time.
 *
 * Signing (B6 in the hub) fills the documenso* columns, `signingUrl`, and on
 * completion `signedPath` + `signedAt`.
 */
export const contactDocumentModel = pgTable(
  "ContactDocument",
  {
    ...sharedColumns,
    title: text().notNull(),
    ref: text().notNull(),
    status: contactDocumentStatus().notNull().default("generated"),
    path: text(),
    fileSize: integer(),
    /** Base62, 22 characters (128 random bits): the only thing in /f/<token>. */
    token: text().notNull(),
    tokenExpiresAt: timestamp(timestampConfig).notNull(),
    error: text(),
    documensoEnvelopeId: text(),
    documensoDocumentId: integer(),
    signingUrl: text(),
    signedPath: text(),
    signedAt: timestamp(timestampConfig),
    workspaceId: bigintAsString()
      .notNull()
      .references(() => workspaceModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    contactId: bigintAsString()
      .notNull()
      .references(() => contactModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    templateId: bigintAsString().references(() => documentTemplateModel.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
  },
  (table) => [
    uniqueIndex("ContactDocument_token_key").on(table.token),
    uniqueIndex("ContactDocument_contactId_ref_key").on(
      table.contactId,
      table.ref,
    ),
    uniqueIndex("ContactDocument_documensoDocumentId_key").on(
      table.documensoDocumentId,
    ),
    index("ContactDocument_workspaceId_contactId_createdAt_idx").on(
      table.workspaceId,
      table.contactId,
      table.createdAt,
    ),
  ],
)
