import { index, pgTable, text } from "drizzle-orm/pg-core"
import { bigintAsString, sharedColumns } from "../partials/shared"
import { userModel } from "./auth-user"
import { contactModel } from "./contact"
import { sequenceModel } from "./sequence"
import { workspaceModel } from "./workspace"

/**
 * s228b outreach step 2: one classification of a contact's answer to outreach
 * (the newest is the contact's current one). `class` is a replyClasses value,
 * `source` a replyClassificationSources value; `sequenceId` is the outreach
 * enrolment it was made for, `dealId` the deal it opened or moved (no FK: a
 * deleted deal keeps the history).
 */
export const replyClassificationModel = pgTable(
  "ReplyClassification",
  {
    ...sharedColumns,
    class: text().notNull(),
    source: text().notNull(),
    reason: text(),
    messageId: text(),
    dealId: bigintAsString(),
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
    index("ReplyClassification_workspaceId_contactId_createdAt_idx").on(
      table.workspaceId,
      table.contactId,
      table.createdAt,
    ),
  ],
)
