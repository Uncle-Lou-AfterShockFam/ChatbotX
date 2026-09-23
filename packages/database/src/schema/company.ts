import { sql } from "drizzle-orm"
import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import {
  bigintAsString,
  sharedColumns,
  timestampConfig,
} from "../partials/shared"
import { workspaceModel } from "./workspace"

/**
 * A company groups contacts (`Contact.companyId`). The company stop rule
 * marks the whole company stopped (`stoppedAt`) when any of its contacts
 * replies, when the workspace's stop tag is applied to one of them, when the
 * public API says so, or when a deal opens. `stoppedByContactId` is
 * informational and carries no FK so this file never imports `contact.ts`.
 */
export const companyModel = pgTable(
  "Company",
  {
    ...sharedColumns,
    name: text().notNull(),
    /** Lower-cased email domains (no `@`); an inbound email at one of them auto-links the contact. */
    domains: text().array().notNull().default(sql`'{}'`),
    website: text(),
    phone: text(),
    notes: text(),
    /** When false an inbound reply or the stop tag does not stop the company; the API and deals still do. */
    stopOnReply: boolean().default(true).notNull(),
    stoppedAt: timestamp(timestampConfig),
    stopReason: text(),
    stoppedByContactId: bigintAsString(),
    workspaceId: bigintAsString()
      .notNull()
      .references(() => workspaceModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
  },
  (table) => [
    uniqueIndex("Company_workspaceId_name_key").using(
      "btree",
      table.workspaceId.asc().nullsLast(),
      table.name.asc().nullsLast(),
    ),
    index("Company_workspaceId_stoppedAt_idx").on(
      table.workspaceId,
      table.stoppedAt,
    ),
    index("Company_domains_idx").using("gin", table.domains),
  ],
)
