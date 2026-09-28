import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import {
  type EmailTemplateStatus,
  emailTemplateStatuses,
} from "../partials/email-template"
import { bigintAsString, sharedColumns } from "../partials/shared"
import { userModel } from "./auth-user"
import { workspaceModel } from "./workspace"

export const emailTemplateStatus = pgEnum(
  "emailTemplateStatus",
  emailTemplateStatuses.options as [
    EmailTemplateStatus,
    ...EmailTemplateStatus[],
  ],
)

/**
 * An email template (roadmap B2): `document` is an EmailDocument v1
 * (@chatbotx.io/email-document), validated by `parseDocument` on every write
 * and read by the renderer; never trusted as stored.
 */
export const emailTemplateModel = pgTable(
  "EmailTemplate",
  {
    ...sharedColumns,
    name: text().notNull(),
    document: jsonb().notNull(),
    status: emailTemplateStatus().notNull().default("active"),
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
    index("EmailTemplate_workspaceId_status_idx").on(
      table.workspaceId,
      table.status,
    ),
    uniqueIndex("EmailTemplate_workspaceId_name_key").on(
      table.workspaceId,
      table.name,
    ),
  ],
)
