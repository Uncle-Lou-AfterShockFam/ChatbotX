import { index, jsonb, pgEnum, pgTable } from "drizzle-orm/pg-core"
import {
  type CompanyActivityType,
  companyActivityTypes,
} from "../partials/company"
import { bigintAsString, sharedColumns } from "../partials/shared"
import { userModel } from "./auth-user"
import { companyModel } from "./company"
import { workspaceModel } from "./workspace"

export const companyActivityType = pgEnum(
  "companyActivityType",
  companyActivityTypes.options as [
    CompanyActivityType,
    ...CompanyActivityType[],
  ],
)

/**
 * The company change log (s195 CRM 360): an append-only row per company
 * mutation, note, contact link / unlink and deal event on a company deal.
 * `payload` is written explicitly on every insert (no jsonb `.default()`,
 * see AGENTS.md) and is closed per type in the business layer.
 */
export const companyActivityModel = pgTable(
  "CompanyActivity",
  {
    ...sharedColumns,
    type: companyActivityType().notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
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
    actorId: bigintAsString().references(() => userModel.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
  },
  (table) => [
    index("CompanyActivity_companyId_createdAt_idx").on(
      table.companyId,
      table.createdAt,
    ),
  ],
)
