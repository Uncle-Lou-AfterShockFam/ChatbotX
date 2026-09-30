import { sql } from "drizzle-orm"
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import {
  type EmailSenderProvider,
  type EmailSenderStatus,
  emailSenderProviders,
  emailSenderStatuses,
} from "../partials/email-sender"
import { bigintAsString, sharedColumns } from "../partials/shared"
import { inboxModel } from "./inbox"
import { workspaceModel } from "./workspace"

export const emailSenderProvider = pgEnum(
  "emailSenderProvider",
  emailSenderProviders.options as [
    EmailSenderProvider,
    ...EmailSenderProvider[],
  ],
)

export const emailSenderStatus = pgEnum(
  "emailSenderStatus",
  emailSenderStatuses.options as [EmailSenderStatus, ...EmailSenderStatus[]],
)

/**
 * A mailbox an email LINE sends from (ManyReach step 3, s229b). `address` is
 * trimmed and lower-cased. `secret` is the encrypted credential blob
 * (`encryptUtils.encryptObject`, AAD `email-sender:<id>`): it never leaves
 * the business layer except through the line's credential feed. A sender is
 * ARCHIVED, never deleted (EmailThreadMail.senderId references it), so one
 * address may come back on the line after its archived row.
 */
export const emailSenderModel = pgTable(
  "EmailSender",
  {
    ...sharedColumns,
    workspaceId: bigintAsString()
      .notNull()
      .references(() => workspaceModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    lineInboxId: bigintAsString()
      .notNull()
      .references(() => inboxModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    provider: emailSenderProvider().notNull(),
    address: text().notNull(),
    fromName: text().notNull(),
    firstName: text().notNull(),
    lastName: text().notNull(),
    replyTo: text(),
    signature: text(),
    dailyLimit: integer().notNull().default(25),
    rampStart: integer(),
    rampPercent: integer(),
    minGapMinutes: integer().notNull().default(10),
    status: emailSenderStatus().notNull().default("active"),
    disconnectionReason: text(),
    secret: jsonb().notNull(),
  },
  (table) => [
    uniqueIndex("EmailSender_lineInboxId_address_live_key")
      .on(table.lineInboxId, table.address)
      .where(sql`${table.status} <> 'archived'`),
    index("EmailSender_workspaceId_lineInboxId_idx").on(
      table.workspaceId,
      table.lineInboxId,
    ),
  ],
)
