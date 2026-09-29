import {
  and,
  type DatabaseClient,
  db,
  desc,
  eq,
  inArray,
  lt,
} from "@chatbotx.io/database/client"
import {
  type EmailSuppressionReason,
  type EmailSuppressionRefusal,
  emailSuppressionKeysFor,
  parseEmailSuppression,
} from "@chatbotx.io/database/partials"
import { emailSuppressionModel } from "@chatbotx.io/database/schema"
import type { EmailSuppressionModel } from "@chatbotx.io/database/types"
import { createId } from "@chatbotx.io/utils"
import { BaseService } from "../base.service"
import { notFoundException, validationException } from "../errors"

const SUPPRESSION_NOT_FOUND = "Suppression entry not found"
const LIST_DEFAULT_LIMIT = 50
const LIST_MAX_LIMIT = 100
const BIGINT_ID = /^\d{1,19}$/

const REFUSAL_MESSAGES: Record<EmailSuppressionRefusal, string> = {
  "not-a-string": "Enter an email address or @domain",
  empty: "Enter an email address or @domain",
  "too-long": "The entry is longer than 254 characters",
  whitespace: "The entry cannot contain spaces",
  "no-at": "Use a full address (name@example.com) or @example.com",
  "multiple-at": "The entry can contain only one @",
  "bad-domain": "The domain is not valid",
}

export class EmailSuppressionService extends BaseService {
  /**
   * True when `address` must not be mailed: its exact address or its
   * `@domain` is listed for the workspace. An address that does not parse as
   * ONE address is suppressed (fail closed); a lookup error propagates.
   */
  async isSuppressed(props: {
    workspaceId: string
    address: unknown
    tx?: DatabaseClient
  }): Promise<boolean> {
    const { workspaceId, address, tx = db } = props
    const keys = emailSuppressionKeysFor(address)
    if (!keys) {
      return true
    }
    const rows = await tx
      .select({ id: emailSuppressionModel.id })
      .from(emailSuppressionModel)
      .where(
        and(
          eq(emailSuppressionModel.workspaceId, workspaceId),
          inArray(emailSuppressionModel.value, keys),
        ),
      )
      .limit(1)
    return rows.length > 0
  }

  async list(props: {
    workspaceId: string
    cursor?: string | null
    limit?: number
    tx?: DatabaseClient
  }): Promise<{ items: EmailSuppressionModel[]; nextCursor: string | null }> {
    const { workspaceId, cursor = null, tx = db } = props
    if (cursor !== null && !BIGINT_ID.test(cursor)) {
      throw validationException("cursor", "Invalid cursor")
    }
    const limit = Math.min(
      Math.max(Math.trunc(props.limit ?? LIST_DEFAULT_LIMIT), 1),
      LIST_MAX_LIMIT,
    )
    const rows = await tx
      .select()
      .from(emailSuppressionModel)
      .where(
        cursor === null
          ? eq(emailSuppressionModel.workspaceId, workspaceId)
          : and(
              eq(emailSuppressionModel.workspaceId, workspaceId),
              lt(emailSuppressionModel.id, cursor),
            ),
      )
      .orderBy(desc(emailSuppressionModel.id))
      .limit(limit + 1)
    const items = rows.slice(0, limit)
    return {
      items,
      nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null,
    }
  }

  /**
   * Adds an entry; adding a value that is already listed returns the existing
   * row (idempotent). An unparseable value is a 422 on `value`.
   */
  async add(props: {
    workspaceId: string
    value: unknown
    reason?: EmailSuppressionReason
    source?: string | null
    userId?: string | null
    tx?: DatabaseClient
  }): Promise<EmailSuppressionModel> {
    const {
      workspaceId,
      reason = "manual",
      source = null,
      userId = null,
      tx = db,
    } = props
    const parsed = parseEmailSuppression(props.value)
    if (!parsed.ok) {
      throw validationException("value", REFUSAL_MESSAGES[parsed.reason])
    }
    const [row] = await tx
      .insert(emailSuppressionModel)
      .values({
        id: createId(),
        workspaceId,
        value: parsed.value,
        kind: parsed.kind,
        reason,
        source,
        createdById: userId,
      })
      .onConflictDoNothing()
      .returning()
    if (row) {
      await this.audit(
        "create",
        `suppressed an email ${parsed.kind} (#${row.id}, ${reason})`,
      )
      return row
    }
    const [existing] = await tx
      .select()
      .from(emailSuppressionModel)
      .where(
        and(
          eq(emailSuppressionModel.workspaceId, workspaceId),
          eq(emailSuppressionModel.value, parsed.value),
        ),
      )
      .limit(1)
    if (!existing) {
      // Lost a race with a concurrent remove; the entry is not listed.
      throw notFoundException(SUPPRESSION_NOT_FOUND)
    }
    return existing
  }

  async remove(props: {
    workspaceId: string
    id: string
    tx?: DatabaseClient
  }): Promise<void> {
    const { workspaceId, id, tx = db } = props
    const deleted = await tx
      .delete(emailSuppressionModel)
      .where(
        and(
          eq(emailSuppressionModel.id, id),
          eq(emailSuppressionModel.workspaceId, workspaceId),
        ),
      )
      .returning({ id: emailSuppressionModel.id })
    if (deleted.length === 0) {
      throw notFoundException(SUPPRESSION_NOT_FOUND)
    }
    await this.audit("delete", `removed an email suppression (#${id})`)
  }
}

export const emailSuppressionService = new EmailSuppressionService()
