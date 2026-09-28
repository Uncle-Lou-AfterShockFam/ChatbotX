import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import { bigintAsString, sharedColumns } from "../partials/shared"
import { folderModel } from "./folder"
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
