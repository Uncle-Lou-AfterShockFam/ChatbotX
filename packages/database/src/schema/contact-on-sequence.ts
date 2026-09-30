import { createId } from "@chatbotx.io/utils"
import { sql } from "drizzle-orm"
import {
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import { bigintAsString, timestampConfig } from "../partials/shared"
import { contactModel } from "./contact"
import { sequenceModel } from "./sequence"
import { workspaceModel } from "./workspace"

export const contactsOnSequenceModel = pgTable(
  "ContactOnSequence",
  {
    id: bigintAsString()
      .$defaultFn(() => createId())
      .notNull(),
    createdAt: timestamp(timestampConfig).defaultNow().notNull(),
    updatedAt: timestamp(timestampConfig)
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`CURRENT_TIMESTAMP`),
    enrolledAt: timestamp(timestampConfig).notNull().defaultNow(),
    completedAt: timestamp(timestampConfig),
    currentStep: integer().notNull().default(0),
    status: text(),
    nextRunAt: timestamp(timestampConfig),
    lastStepId: bigintAsString(),
    nextStepId: bigintAsString(),
    lockedAt: timestamp(timestampConfig),
    lockOwner: text(),
    lastError: text(),
    /**
     * Outreach B-1 (s226b): an out-of-office answer holds the enrolment's
     * next step until this instant (its pending dispatches were moved
     * here; advanceEnrollment never schedules before it). Expires by time.
     */
    pausedUntil: timestamp(timestampConfig),
    /**
     * s228b (owner: the row is KEPT): a removal ends the enrolment
     * (status 'ended') instead of deleting it; the reason and instant stay.
     */
    endedAt: timestamp(timestampConfig),
    endReason: text(),
    /** none | replied | ooo | bounced - never the pipeline stage. */
    replyState: text().notNull().default("none"),
    repliedAt: timestamp(timestampConfig),
    contactId: bigintAsString()
      .notNull()
      .references(() => contactModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    sequenceId: bigintAsString()
      .notNull()
      .references(() => sequenceModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    workspaceId: bigintAsString()
      .notNull()
      .references(() => workspaceModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
  },
  (table) => [
    primaryKey({
      columns: [table.id, table.workspaceId],
      name: "ContactOnSequence_pkey",
    }),
    index("ContactsOnSequence_sequenceId_idx").on(table.sequenceId),
    index("ContactsOnSequence_contactId_idx").on(table.contactId),
    index("ContactsOnSequence_workspaceId_idx").on(table.workspaceId),
    index("ContactsOnSequence_status_nextRunAt_idx").on(
      table.status,
      table.nextRunAt,
    ),
    index("ContactsOnSequence_workspaceId_status_nextRunAt_idx").on(
      table.workspaceId,
      table.status,
      table.nextRunAt,
    ),
    uniqueIndex("ContactsOnSequence_contactId_sequenceId_workspaceId_key").on(
      table.contactId,
      table.sequenceId,
      table.workspaceId,
    ),
  ],
)
