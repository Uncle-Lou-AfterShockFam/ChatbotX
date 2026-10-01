import {
  boolean,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import { bigintAsString, sharedColumns } from "../partials/shared"
import { inboxModel } from "./inbox"
import { workspaceModel } from "./workspace"

/**
 * What a bulktext line behind an API channel carries (s231b, owner decision
 * 2026-10-01). Only an `email` line may hold mailbox senders: its token
 * receives their live credentials (passwords, Google access tokens) through
 * `GET /v1/channels/api/senders`. Null = not an email line. Closed on purpose;
 * a new kind is a migration, never a free-form string.
 */
export const integrationApiLineKinds = ["email"] as const
export const integrationApiLineKind = pgEnum(
  "integrationApiLineKind",
  integrationApiLineKinds,
)

export const integrationApiModel = pgTable(
  "IntegrationApi",
  {
    ...sharedColumns,
    auth: jsonb().$type<{ [x: string]: unknown }>().notNull(),
    name: text().notNull(),
    tokenHash: text().notNull(),
    tokenPrefix: text().notNull(),
    callbackUrl: text(),
    enabled: boolean().notNull().default(true),
    lineKind: integrationApiLineKind(),
    workspaceId: bigintAsString()
      .notNull()
      .references(() => workspaceModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    inboxId: bigintAsString()
      .notNull()
      .references(() => inboxModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
  },
  (table) => [
    index("IntegrationApi_workspaceId_idx").using(
      "btree",
      table.workspaceId.asc().nullsLast(),
    ),
    uniqueIndex("IntegrationApi_inboxId_key").using(
      "btree",
      table.inboxId.asc().nullsLast(),
    ),
    uniqueIndex("IntegrationApi_tokenHash_key").using(
      "btree",
      table.tokenHash.asc().nullsLast(),
    ),
  ],
)
