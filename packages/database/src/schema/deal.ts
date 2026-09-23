import {
  doublePrecision,
  index,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core"
import {
  dealActivityTypes,
  dealPriorities,
  dealStatuses,
} from "../partials/deal"
import {
  bigintAsString,
  sharedColumns,
  timestampConfig,
} from "../partials/shared"
import { userModel } from "./auth-user"
import { companyModel } from "./company"
import { contactModel } from "./contact"
import { pipelineModel, pipelineStageModel } from "./pipeline"
import { workspaceModel } from "./workspace"

export const dealStatus = pgEnum(
  "dealStatus",
  dealStatuses.options as [string, ...string[]],
)

export const dealPriority = pgEnum(
  "dealPriority",
  dealPriorities.options as [string, ...string[]],
)

export const dealActivityType = pgEnum(
  "dealActivityType",
  dealActivityTypes.options as [string, ...string[]],
)

/**
 * A deal sits in exactly one stage of one pipeline. `stageId` is RESTRICT so a
 * stage with deals cannot be deleted by accident (the service moves them
 * first). `value` is numeric(14,2) and compared as its normalised string.
 * `position` orders cards inside a stage (midpoint inserts, renormalised by the
 * service when the gap collapses). `fields` is written explicitly on every
 * insert (no jsonb `.default()`, see AGENTS.md).
 */
export const dealModel = pgTable(
  "Deal",
  {
    ...sharedColumns,
    title: text().notNull(),
    value: numeric({ precision: 14, scale: 2 }),
    currency: varchar({ length: 3 }).notNull(),
    status: dealStatus().notNull().default("open"),
    priority: dealPriority().notNull().default("medium"),
    position: doublePrecision().notNull().default(0),
    dueAt: timestamp(timestampConfig),
    closedAt: timestamp(timestampConfig),
    fields: jsonb().$type<Record<string, unknown>>().notNull(),
    workspaceId: bigintAsString()
      .notNull()
      .references(() => workspaceModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    pipelineId: bigintAsString()
      .notNull()
      .references(() => pipelineModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    stageId: bigintAsString()
      .notNull()
      .references(() => pipelineStageModel.id, {
        onDelete: "restrict",
        onUpdate: "cascade",
      }),
    contactId: bigintAsString().references(() => contactModel.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    companyId: bigintAsString().references(() => companyModel.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    ownerId: bigintAsString().references(() => userModel.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
  },
  (table) => [
    index("Deal_workspaceId_pipelineId_stageId_position_idx").on(
      table.workspaceId,
      table.pipelineId,
      table.stageId,
      table.position,
    ),
    index("Deal_workspaceId_contactId_status_idx").on(
      table.workspaceId,
      table.contactId,
      table.status,
    ),
    index("Deal_workspaceId_companyId_idx").on(
      table.workspaceId,
      table.companyId,
    ),
  ],
)

/**
 * Append-only history of a deal. `payload` carries the before/after of the
 * change (`{from, to}` for stage/value/status/priority/owner, `{text}` for a
 * note) and is written explicitly on every insert. `actorId` is the user who
 * made the change, null for a flow step or the public API.
 */
export const dealActivityModel = pgTable(
  "DealActivity",
  {
    ...sharedColumns,
    type: dealActivityType().notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    dealId: bigintAsString()
      .notNull()
      .references(() => dealModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    actorId: bigintAsString().references(() => userModel.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
  },
  (table) => [
    index("DealActivity_dealId_createdAt_idx").on(
      table.dealId,
      table.createdAt,
    ),
  ],
)
