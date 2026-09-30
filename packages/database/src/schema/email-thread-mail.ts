import { sql } from "drizzle-orm"
import { index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core"
import { bigintAsString, sharedColumns } from "../partials/shared"
import { contactModel } from "./contact"
import { inboxModel } from "./inbox"
import { workspaceModel } from "./workspace"

/**
 * Outreach B-1 PR 3 (s226b): one mail exchanged with a contact on an email
 * LINE, in either direction, so a later email step can reply under it
 * (thread modes `previous` / `campaign` / `latest`).
 * - `outgoing`: a mail the line queued. `messageKey` is the Message-ID local
 *   part the hub minted (the line appends its From domain).
 * - `incoming`: the contact's own mail. `messageId` is its full RFC id.
 * `parents` is what the mail cited, OLDEST FIRST in one list (skeptic
 * s226b: a mixed thread must keep its real root when trimmed): a hub key
 * bare (`bt.x`), a foreign RFC id in brackets (`<x@host>`). A reply under
 * the mail cites its parents + the mail itself. The source ids carry no
 * foreign key on purpose: deleting that campaign must not erase which
 * campaign a mail belonged to (a `campaign`-mode step would otherwise see
 * "no thread" and could stop a live enrolment).
 */
export const emailThreadMailModel = pgTable(
  "EmailThreadMail",
  {
    ...sharedColumns,
    direction: text().$type<"outgoing" | "incoming">().notNull(),
    messageKey: text(),
    messageId: text(),
    subject: text().notNull(),
    parents: text().array().notNull().default(sql`'{}'::text[]`),
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
    lineInboxId: bigintAsString()
      .notNull()
      .references(() => inboxModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    sequenceId: bigintAsString(),
    broadcastId: bigintAsString(),
    flowId: bigintAsString(),
  },
  (table) => [
    uniqueIndex("EmailThreadMail_workspaceId_lineInboxId_messageKey_key").on(
      table.workspaceId,
      table.lineInboxId,
      table.messageKey,
    ),
    uniqueIndex("EmailThreadMail_workspaceId_lineInboxId_messageId_key").on(
      table.workspaceId,
      table.lineInboxId,
      table.messageId,
    ),
    index("EmailThreadMail_contact_line_createdAt_idx").on(
      table.workspaceId,
      table.contactId,
      table.lineInboxId,
      table.createdAt.desc(),
    ),
  ],
)
