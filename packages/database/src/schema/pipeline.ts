import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import type { PipelineSettings } from "../partials/deal"
import { bigintAsString, sharedColumns } from "../partials/shared"
import { workspaceModel } from "./workspace"

/**
 * A pipeline is an ordered set of stages deals move through. `settings` is
 * written explicitly on every insert (no drizzle `.default()`: see AGENTS.md,
 * a jsonb default is not a database default).
 *
 * Phase 2 (not created here, reserved): `PipelineMember` (round-robin owners
 * and per-pipeline access), `DealTask`, `DealTaskTemplate`, `DealDependency`,
 * `DealComment` + mentions.
 */
export const pipelineModel = pgTable(
  "Pipeline",
  {
    ...sharedColumns,
    name: text().notNull(),
    order: doublePrecision().notNull().default(0),
    settings: jsonb().$type<PipelineSettings>().notNull(),
    workspaceId: bigintAsString()
      .notNull()
      .references(() => workspaceModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
  },
  (table) => [
    uniqueIndex("Pipeline_workspaceId_name_key").using(
      "btree",
      table.workspaceId.asc().nullsLast(),
      table.name.asc().nullsLast(),
    ),
    index("Pipeline_workspaceId_order_idx").on(table.workspaceId, table.order),
  ],
)

/**
 * A stage of a pipeline. `isWon` / `isLost` mark the terminal columns: moving a
 * deal onto one closes it with that status. `probability` (0-100) is
 * informational.
 */
export const pipelineStageModel = pgTable(
  "PipelineStage",
  {
    ...sharedColumns,
    name: text().notNull(),
    order: doublePrecision().notNull().default(0),
    color: text(),
    probability: integer().notNull().default(0),
    isWon: boolean().notNull().default(false),
    isLost: boolean().notNull().default(false),
    pipelineId: bigintAsString()
      .notNull()
      .references(() => pipelineModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
  },
  (table) => [
    index("PipelineStage_pipelineId_order_idx").on(
      table.pipelineId,
      table.order,
    ),
  ],
)
