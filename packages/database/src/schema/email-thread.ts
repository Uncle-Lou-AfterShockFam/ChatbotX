import { sql } from "drizzle-orm"
import { pgTable, text, uniqueIndex } from "drizzle-orm/pg-core"
import { bigintAsString, sharedColumns } from "../partials/shared"
import { contactModel } from "./contact"
import { inboxModel } from "./inbox"
import { sequenceModel } from "./sequence"
import { workspaceModel } from "./workspace"

/**
 * Outreach B-1 (s225b): one contact's plain-text mail thread in one sequence.
 * The first text step sent over an email line creates it; every later step
 * replies under it (`Re: <subject>`, References = `keys`). `keys` are the
 * Message-ID LOCAL parts the hub minted, in send order (the line appends
 * its From domain); `lineInboxId` pins the thread to the line that started
 * it, since a key only resolves on that line's domain.
 */
export const emailThreadModel = pgTable(
  "EmailThread",
  {
    ...sharedColumns,
    subject: text().notNull(),
    keys: text().array().notNull().default(sql`'{}'::text[]`),
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
    sequenceId: bigintAsString()
      .notNull()
      .references(() => sequenceModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    lineInboxId: bigintAsString()
      .notNull()
      .references(() => inboxModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
  },
  (table) => [
    uniqueIndex("EmailThread_workspaceId_contactId_sequenceId_key").on(
      table.workspaceId,
      table.contactId,
      table.sequenceId,
    ),
  ],
)
