import { sql } from "drizzle-orm"
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import { type DealTaskStatus, dealTaskStatuses } from "../partials/deal"
import {
  bigintAsString,
  sharedColumns,
  timestampConfig,
} from "../partials/shared"
import { userModel } from "./auth-user"
import { dealModel } from "./deal"
import { pipelineModel, pipelineStageModel } from "./pipeline"
import { workspaceModel } from "./workspace"

export const dealTaskStatus = pgEnum(
  "dealTaskStatus",
  dealTaskStatuses.options as [DealTaskStatus, ...DealTaskStatus[]],
)

/**
 * A task template on a pipeline stage: when a deal ENTERS the stage the
 * service instantiates one DealTask per template (idempotent per
 * `(dealId, templateId)`). `dueInDays` null = no due date; `assignToOwner`
 * wins over `assigneeId`.
 */
export const dealTaskTemplateModel = pgTable(
  "DealTaskTemplate",
  {
    ...sharedColumns,
    title: text().notNull(),
    description: text(),
    dueInDays: integer(),
    assignToOwner: boolean().notNull().default(false),
    order: doublePrecision().notNull().default(0),
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
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    assigneeId: bigintAsString().references(() => userModel.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
  },
  (table) => [
    index("DealTaskTemplate_stageId_order_idx").on(table.stageId, table.order),
  ],
)

/**
 * A task on a deal. `blocked` is never stored: it is derived at read time
 * from DealDependency rows whose blocker is still open. `overdueNotifiedAt`
 * is the claim column of the overdue scanner (one `taskOverdue` per task; a
 * due date moved into the future clears it).
 */
export const dealTaskModel = pgTable(
  "DealTask",
  {
    ...sharedColumns,
    title: text().notNull(),
    description: text(),
    status: dealTaskStatus().notNull().default("open"),
    dueAt: timestamp(timestampConfig),
    completedAt: timestamp(timestampConfig),
    overdueNotifiedAt: timestamp(timestampConfig),
    workspaceId: bigintAsString()
      .notNull()
      .references(() => workspaceModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    dealId: bigintAsString()
      .notNull()
      .references(() => dealModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    templateId: bigintAsString().references(() => dealTaskTemplateModel.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    assigneeId: bigintAsString().references(() => userModel.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    createdById: bigintAsString().references(() => userModel.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    completedById: bigintAsString().references(() => userModel.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
  },
  (table) => [
    index("DealTask_dealId_status_idx").on(table.dealId, table.status),
    index("DealTask_assigneeId_idx").on(table.assigneeId),
    // The overdue scanner's candidate set: open, not yet notified.
    index("DealTask_dueAt_open_unnotified_idx")
      .on(table.dueAt)
      .where(
        sql`${table.status} = 'open' AND ${table.overdueNotifiedAt} IS NULL`,
      ),
    // A template instantiates at most once per deal (re-entering a stage
    // never duplicates its tasks).
    uniqueIndex("DealTask_dealId_templateId_key")
      .on(table.dealId, table.templateId)
      .where(sql`${table.templateId} IS NOT NULL`),
  ],
)

/** `taskId` is blocked until `dependsOnTaskId` is done. Both tasks belong to the same deal (service-enforced). */
export const dealDependencyModel = pgTable(
  "DealDependency",
  {
    ...sharedColumns,
    workspaceId: bigintAsString()
      .notNull()
      .references(() => workspaceModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    taskId: bigintAsString()
      .notNull()
      .references(() => dealTaskModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    dependsOnTaskId: bigintAsString()
      .notNull()
      .references(() => dealTaskModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
  },
  (table) => [
    uniqueIndex("DealDependency_taskId_dependsOnTaskId_key").on(
      table.taskId,
      table.dependsOnTaskId,
    ),
    index("DealDependency_dependsOnTaskId_idx").on(table.dependsOnTaskId),
    check(
      "DealDependency_no_self_check",
      sql`${table.taskId} <> ${table.dependsOnTaskId}`,
    ),
  ],
)
