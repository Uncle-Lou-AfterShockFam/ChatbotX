import { index, pgTable, text } from "drizzle-orm/pg-core"
import { bigintAsString, sharedColumns } from "../partials/shared"
import { userModel } from "./auth-user"
import { companyModel } from "./company"
import { workspaceModel } from "./workspace"

/**
 * A free-text note on a company (s195 CRM 360). Scoped by `workspaceId` as
 * well as `companyId` (the DealComment pattern) so a cross-workspace id guess
 * is a plain `where`, never a join. Deleting the company deletes its notes.
 */
export const companyNoteModel = pgTable(
  "CompanyNote",
  {
    ...sharedColumns,
    text: text().notNull(),
    workspaceId: bigintAsString()
      .notNull()
      .references(() => workspaceModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    companyId: bigintAsString()
      .notNull()
      .references(() => companyModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    createdById: bigintAsString().references(() => userModel.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
  },
  (table) => [
    index("CompanyNote_companyId_createdAt_idx").on(
      table.companyId,
      table.createdAt,
    ),
  ],
)
