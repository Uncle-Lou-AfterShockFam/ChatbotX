import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import type { OutreachStages } from "../partials/reply-classification"
import { bigintAsString, sharedColumns } from "../partials/shared"
import { folderModel } from "./folder"
import { pipelineModel } from "./pipeline"
import { workspaceModel } from "./workspace"

export const sequenceModel = pgTable(
  "Sequence",
  {
    ...sharedColumns,
    name: text().notNull(),
    folderId: bigintAsString().references(() => folderModel.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    active: boolean().notNull().default(true),
    // Per-contact stop rule (s220b): an inbound reply from an enrolled
    // contact ends that contact's enrolment in this sequence only.
    stopOnReply: boolean().notNull().default(false),
    // s228b outreach step 2: classified replies open or move a deal in this
    // pipeline; `outreachStages` maps each class to one of its stages.
    outreachPipelineId: bigintAsString().references(() => pipelineModel.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    outreachStages: jsonb().$type<OutreachStages>(),
    subscribers: integer().notNull().default(0),
    messages: integer().notNull().default(0),
    workspaceId: bigintAsString()
      .notNull()
      .references(() => workspaceModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
  },
  (table) => [
    index("Sequence_folderId_idx").on(table.folderId),
    uniqueIndex("Sequence_workspaceId_name_key").on(
      table.workspaceId,
      table.name,
    ),
  ],
)
