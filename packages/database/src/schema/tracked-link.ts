import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import {
  bigintAsString,
  sharedColumns,
  timestampConfig,
} from "../partials/shared"
import { contactModel } from "./contact"
import { contactInboxModel } from "./contact-inbox"
import { workspaceModel } from "./workspace"

/**
 * A short, trackable stand-in for one URL inside one outbound text.
 *
 * Minted by the chat worker when a `bulktextSend` step has `trackLinks` on:
 * every URL in the rendered text is replaced by `${appUrl}/go/<token>` and the
 * public `/go/[token]` route redirects to `url` while recording the visit.
 * Short matters here (the text goes over SMS/iMessage), which is why this is
 * not `AnalyticsEmailTopic`: that row carries its destination in a signed
 * query parameter and needs an email topic to hang off.
 *
 * One row per URL occurrence per send, never shared between contacts, so a
 * hit on a token is attributable to exactly one contact. `flowId`/`stepId`
 * are stored as text (not FKs): the message id is minted after the text is
 * rewritten, and a deleted flow must not cascade the click history away.
 *
 * `prefetchCount` counts visits that looked like a link-preview fetch
 * (iMessage, Slack, ...) rather than a person tapping; only human-looking
 * visits bump `clickCount` and mark the contact.
 */
const trackedLinkKinds = ["link", "pixel"] as const
export type TrackedLinkKind = (typeof trackedLinkKinds)[number]

export const trackedLinkModel = pgTable(
  "TrackedLink",
  {
    ...sharedColumns,
    /** Base62, 11 characters (64 random bits); the only thing in the short URL. */
    token: text().notNull(),
    workspaceId: bigintAsString()
      .notNull()
      .references(() => workspaceModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    contactId: bigintAsString()
      .notNull()
      .references(() => contactModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    contactInboxId: bigintAsString().references(() => contactInboxModel.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    flowId: text(),
    stepId: text(),
    /**
     * `link`: a URL rewritten in the text, served by `/go/[token]` (302).
     * `pixel`: the open beacon of one mail, served by `/go/[token]/o` as a
     * 1x1 GIF; `url` is empty and the open counters below apply.
     */
    kind: text().$type<TrackedLinkKind>().default("link").notNull(),
    /** The destination as it stood in the text; validated as http(s) at mint; empty for a pixel. */
    url: text().notNull(),
    firstClickedAt: timestamp(timestampConfig),
    lastClickedAt: timestamp(timestampConfig),
    clickCount: integer().default(0).notNull(),
    prefetchCount: integer().default(0).notNull(),
    firstOpenedAt: timestamp(timestampConfig),
    lastOpenedAt: timestamp(timestampConfig),
    openCount: integer().default(0).notNull(),
  },
  (table) => [
    uniqueIndex("TrackedLink_token_key").using(
      "btree",
      table.token.asc().nullsLast(),
    ),
    index("TrackedLink_workspaceId_contactId_idx").using(
      "btree",
      table.workspaceId.asc().nullsLast(),
      table.contactId.asc().nullsLast(),
    ),
    // The retention purge deletes oldest-first by createdAt.
    index("TrackedLink_createdAt_idx").using(
      "btree",
      table.createdAt.asc().nullsLast(),
    ),
  ],
)

export type TrackedLinkModel = typeof trackedLinkModel.$inferSelect
