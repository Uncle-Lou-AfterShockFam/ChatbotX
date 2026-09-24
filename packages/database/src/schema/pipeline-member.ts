import {
  boolean,
  doublePrecision,
  index,
  pgTable,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import { bigintAsString, sharedColumns } from "../partials/shared"
import { userModel } from "./auth-user"
import { pipelineModel } from "./pipeline"
import { workspaceModel } from "./workspace"

/**
 * A workspace member attached to a pipeline (s193). The list is what
 * `settings.access = "members"` gates on and what `settings.assignOwner =
 * "roundRobin"` walks (only rows with `inRotation`), in `order`. One row per
 * (pipeline, user); a user who leaves the workspace cascades out.
 */
export const pipelineMemberModel = pgTable(
  "PipelineMember",
  {
    ...sharedColumns,
    inRotation: boolean().notNull().default(true),
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
    userId: bigintAsString()
      .notNull()
      .references(() => userModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
  },
  (table) => [
    uniqueIndex("PipelineMember_pipelineId_userId_key").on(
      table.pipelineId,
      table.userId,
    ),
    index("PipelineMember_userId_idx").on(table.userId),
  ],
)
