import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core"
import {
  bigintAsString,
  sharedColumns,
  timestampConfig,
} from "../partials/shared"
import { inboxModel } from "./inbox"
import { workspaceModel } from "./workspace"

/**
 * Outbound API-channel envelopes for an inbox in PULL delivery mode
 * (`IntegrationApi.auth.deliveryMode = "pull"`, no callback URL): the line
 * worker behind the inbox polls `GET /v1/channels/api/outbox`, which leases
 * pending rows, and answers each with `POST /v1/channels/api/outbox/{id}/ack`.
 * A lease that is never acked expires (`leaseExpiresAt`) and the row is
 * handed out again; the worker's own idempotency key (the row id) makes a
 * second hand-out harmless.
 */
const apiChannelOutboxStatuses = [
  "pending",
  "leased",
  "acked",
  "refused",
] as const
export type ApiChannelOutboxStatus = (typeof apiChannelOutboxStatuses)[number]

export const apiChannelOutboxModel = pgTable(
  "ApiChannelOutbox",
  {
    ...sharedColumns,
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
    /** Recipient identity on the channel (`contact.sourceId` of the envelope). */
    contactSourceId: text().notNull(),
    /** The exact `message_created` envelope a push-mode callback would have carried. */
    envelope: jsonb().$type<{ [x: string]: unknown }>().notNull(),
    status: text().$type<ApiChannelOutboxStatus>().notNull().default("pending"),
    leasedAt: timestamp(timestampConfig),
    leaseExpiresAt: timestamp(timestampConfig),
    ackedAt: timestamp(timestampConfig),
    /** The worker's answer: `{ messageId?, reason?, warning? }` as posted on ack. */
    result: jsonb().$type<{ [x: string]: unknown }>(),
  },
  (table) => [
    index("ApiChannelOutbox_inboxId_status_idx").using(
      "btree",
      table.inboxId.asc().nullsLast(),
      table.status.asc().nullsLast(),
    ),
    index("ApiChannelOutbox_workspaceId_idx").using(
      "btree",
      table.workspaceId.asc().nullsLast(),
    ),
  ],
)
