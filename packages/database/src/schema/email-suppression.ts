import { pgEnum, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core"
import {
  type EmailSuppressionKind,
  type EmailSuppressionReason,
  emailSuppressionKinds,
  emailSuppressionReasons,
} from "../partials/email-suppression"
import { bigintAsString, sharedColumns } from "../partials/shared"
import { userModel } from "./auth-user"
import { workspaceModel } from "./workspace"

export const emailSuppressionKind = pgEnum(
  "emailSuppressionKind",
  emailSuppressionKinds.options as [
    EmailSuppressionKind,
    ...EmailSuppressionKind[],
  ],
)

export const emailSuppressionReason = pgEnum(
  "emailSuppressionReason",
  emailSuppressionReasons.options as [
    EmailSuppressionReason,
    ...EmailSuppressionReason[],
  ],
)

/**
 * A suppressed email address or `@domain` (outreach B-1, s224b). `value` is
 * always the output of `parseEmailSuppression` (trimmed, lower-cased), so the
 * send-time lookup is an exact match on the unique index. `source` names what
 * added an automatic entry (the line ref of an unreachable send).
 */
export const emailSuppressionModel = pgTable(
  "EmailSuppression",
  {
    ...sharedColumns,
    value: text().notNull(),
    kind: emailSuppressionKind().notNull(),
    reason: emailSuppressionReason().notNull().default("manual"),
    source: text(),
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
    uniqueIndex("EmailSuppression_workspaceId_value_key").on(
      table.workspaceId,
      table.value,
    ),
  ],
)
