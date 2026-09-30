import { sql } from "drizzle-orm"
import { index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core"
import { bigintAsString, sharedColumns } from "../partials/shared"
import { userModel } from "./auth-user"
import { contactModel } from "./contact"
import { dealModel } from "./deal"
import { sequenceModel } from "./sequence"
import { workspaceModel } from "./workspace"

/**
 * s228b outreach step 2: one classification of a contact's answer to outreach
 * (the newest is the contact's current one). `class` is a replyClasses value,
 * `source` a replyClassificationSources value; `sequenceId` is the outreach
 * enrolment it was made for, `dealId` the deal it opened or moved (a deleted
 * deal leaves it null). One row per inbound message (`messageId`): a
 * redelivered event records nothing twice.
 */
export const replyClassificationModel = pgTable(
  "ReplyClassification",
  {
    ...sharedColumns,
    class: text().notNull(),
    source: text().notNull(),
    reason: text(),
    messageId: text(),
    dealId: bigintAsString().references(() => dealModel.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
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
    sequenceId: bigintAsString().references(() => sequenceModel.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    createdById: bigintAsString().references(() => userModel.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
  },
  (table) => [
    uniqueIndex("ReplyClassification_workspaceId_messageId_key")
      .on(table.workspaceId, table.messageId)
      .where(sql`${table.messageId} IS NOT NULL`),
    index("ReplyClassification_workspaceId_contactId_createdAt_idx").on(
      table.workspaceId,
      table.contactId,
      table.createdAt,
    ),
  ],
)
