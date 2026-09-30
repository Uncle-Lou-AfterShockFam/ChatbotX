import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import { type PageStatus, pageStatuses } from "../partials/page"
import {
  bigintAsString,
  sharedColumns,
  timestampConfig,
} from "../partials/shared"
import { userModel } from "./auth-user"
import { contactModel } from "./contact"
import { contactInboxModel } from "./contact-inbox"
import { workspaceModel } from "./workspace"

export const pageStatus = pgEnum(
  "pageStatus",
  pageStatuses.options as [PageStatus, ...PageStatus[]],
)

/**
 * A custom page (roadmap B4): `document` is an EmailDocument v1, validated by
 * `parseDocument` on every write and re-validated on every render. Archiving
 * a page closes every link to it.
 */
export const pageModel = pgTable(
  "Page",
  {
    ...sharedColumns,
    name: text().notNull(),
    document: jsonb().notNull(),
    status: pageStatus().notNull().default("active"),
    linkTtlHours: integer().notNull(),
    workspaceId: bigintAsString()
      .notNull()
      .references(() => workspaceModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    createdById: bigintAsString().references(() => userModel.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
  },
  (table) => [
    index("Page_workspaceId_status_idx").on(table.workspaceId, table.status),
    uniqueIndex("Page_workspaceId_name_key").on(table.workspaceId, table.name),
  ],
)

/**
 * One contact's link to a page: `/p/<token>` renders the page with that
 * contact's CURRENT data until `expiresAt` (nothing rendered is stored).
 * `ref` is the idempotency key per page (a flow run's execution + step), so
 * a retried step returns the same link instead of minting another.
 */
export const pageLinkModel = pgTable(
  "PageLink",
  {
    ...sharedColumns,
    /** Base62, 22 characters (128 random bits): the only thing in /p/<token>. */
    token: text().notNull(),
    ref: text(),
    expiresAt: timestamp(timestampConfig).notNull(),
    firstViewedAt: timestamp(timestampConfig),
    lastViewedAt: timestamp(timestampConfig),
    viewCount: integer().notNull().default(0),
    workspaceId: bigintAsString()
      .notNull()
      .references(() => workspaceModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    pageId: bigintAsString()
      .notNull()
      .references(() => pageModel.id, {
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
  },
  (table) => [
    uniqueIndex("PageLink_token_key").on(table.token),
    uniqueIndex("PageLink_pageId_ref_key").on(table.pageId, table.ref),
    index("PageLink_workspaceId_contactId_idx").on(
      table.workspaceId,
      table.contactId,
    ),
    index("PageLink_expiresAt_idx").on(table.expiresAt),
  ],
)
