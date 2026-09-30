import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core"
import {
  bigintAsString,
  sharedColumns,
  timestampConfig,
} from "../partials/shared"
import { flowModel } from "./flow"
import { sequenceModel } from "./sequence"

export const sequenceStepModel = pgTable(
  "SequenceStep",
  {
    ...sharedColumns,
    order: integer().notNull(),
    delayDays: integer().notNull(),
    delayMinutes: integer().notNull().default(0),
    delayUnit: text(),
    specificDateTime: timestamp(timestampConfig),
    isActive: boolean().notNull().default(true),
    anytime: boolean().notNull().default(true),
    sendTimeStart: text(),
    sendTimeEnd: text(),
    sendDays: text().default(
      '["monday","tuesday","wednesday","thursday","friday","saturday","sunday"]',
    ),
    // s227b outreach B-1 H3: contact fields that must have a value when this
    // step is due; with any missing the enrolment is HELD (reason in
    // ContactOnSequence.lastError) until an operator resumes it.
    holdOnMissing: text().array(),
    flowId: bigintAsString().references(() => flowModel.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    sequenceId: bigintAsString()
      .notNull()
      .references(() => sequenceModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
  },
  (table) => [
    index("SequenceStep_sequenceId_idx").on(table.sequenceId),
    index("SequenceStep_flowId_idx").on(table.flowId),
  ],
)
