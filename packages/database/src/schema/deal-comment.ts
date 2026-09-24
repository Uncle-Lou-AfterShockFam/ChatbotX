import {
  index,
  jsonb,
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
import { userModel } from "./auth-user"
import { dealModel } from "./deal"
import { workspaceModel } from "./workspace"

/** One resolved `@[label](u:<id>)` token of a comment body. */
export type DealCommentMentionRef = { userId: string; label: string }

/**
 * A comment on a deal (s193 part 3b). `body` keeps the raw text with its
 * mention tokens; `mentions` is the parsed list (written explicitly, never by
 * a drizzle default) so readers never re-parse. One `DealCommentMention` row
 * per mentioned user carries the per-user read state (PR5's "my mentions").
 */
export const dealCommentModel = pgTable(
  "DealComment",
  {
    ...sharedColumns,
    body: text().notNull(),
    mentions: jsonb().$type<DealCommentMentionRef[]>().notNull(),
    editedAt: timestamp(timestampConfig),
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
    authorId: bigintAsString().references(() => userModel.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
  },
  (table) => [
    index("DealComment_dealId_createdAt_idx").on(table.dealId, table.createdAt),
  ],
)

export const dealCommentMentionModel = pgTable(
  "DealCommentMention",
  {
    ...sharedColumns,
    readAt: timestamp(timestampConfig),
    workspaceId: bigintAsString()
      .notNull()
      .references(() => workspaceModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    commentId: bigintAsString()
      .notNull()
      .references(() => dealCommentModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    dealId: bigintAsString()
      .notNull()
      .references(() => dealModel.id, {
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
    uniqueIndex("DealCommentMention_commentId_userId_key").on(
      table.commentId,
      table.userId,
    ),
    index("DealCommentMention_userId_readAt_idx").on(
      table.userId,
      table.readAt,
    ),
  ],
)
