import { and, db, eq, inArray, lt, or } from "@chatbotx.io/database/client"
import { apiChannelOutboxModel } from "@chatbotx.io/database/schema"
import { createId } from "@chatbotx.io/utils"
import { BaseService } from "../base.service"

/** How long a leased row stays with the worker before it is handed out again. */
export const OUTBOX_LEASE_MS = 10 * 60_000
/** Upper bound on rows one pull may lease. */
export const OUTBOX_MAX_PULL = 50

export type OutboxAck = {
  messageId?: string | null
  reason?: string | null
  warning?: string | null
}

export type OutboxAckOutcome =
  | { outcome: "acked" | "refused"; contactSourceId: string }
  | { outcome: "not-found" | "already-settled" }

/**
 * The refusal semantics of a pull-mode ack mirror the push-mode callback
 * answer (`assertNotRefused` in the api integration): a non-empty `reason`
 * is a refused send, except `suppressed` WITH a message id, which the worker
 * reports asynchronously as a failed status of its own.
 */
export const isRefusal = (ack: OutboxAck): boolean => {
  if (typeof ack.reason !== "string" || ack.reason === "") {
    return false
  }
  if (
    ack.reason === "suppressed" &&
    typeof ack.messageId === "string" &&
    ack.messageId !== ""
  ) {
    return false
  }
  return true
}

const MAX_ACK_FIELD = 500

/** Closed, bounded shape of what a worker may post on ack. */
export const normalizeAck = (input: unknown): OutboxAck => {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("ack must be an object")
  }
  const out: OutboxAck = {}
  for (const [key, value] of Object.entries(input)) {
    if (key !== "messageId" && key !== "reason" && key !== "warning") {
      throw new TypeError(`ack: unknown key ${key}`)
    }
    if (value === null || value === undefined) {
      continue
    }
    if (typeof value !== "string" || value.length > MAX_ACK_FIELD) {
      throw new TypeError(
        `ack: ${key} must be a string of at most ${MAX_ACK_FIELD} characters`,
      )
    }
    out[key] = value
  }
  return out
}

class ApiChannelOutboxService extends BaseService {
  /** Queue one envelope for the inbox's worker; returns the row id. */
  async enqueue(input: {
    workspaceId: string
    inboxId: string
    contactSourceId: string
    envelope: { [x: string]: unknown }
  }): Promise<string> {
    if (input.contactSourceId === "") {
      throw new TypeError("enqueue: contactSourceId is required")
    }
    const id = createId()
    await db.insert(apiChannelOutboxModel).values({
      id,
      workspaceId: input.workspaceId,
      inboxId: input.inboxId,
      contactSourceId: input.contactSourceId,
      envelope: input.envelope,
      status: "pending",
    })
    return id
  }

  /**
   * Lease up to `limit` rows for the inbox: pending rows, plus leased rows
   * whose lease expired (the worker died mid-batch). Oldest first, so a
   * backlog drains in send order. One UPDATE ... RETURNING keeps two pollers
   * on the same token from leasing the same row.
   */
  async pull(input: { inboxId: string; limit: number; now?: Date }) {
    const now = input.now ?? new Date()
    const limit = Math.min(
      Math.max(1, Math.trunc(input.limit)),
      OUTBOX_MAX_PULL,
    )
    const expires = new Date(now.getTime() + OUTBOX_LEASE_MS)
    const candidates = db
      .select({ id: apiChannelOutboxModel.id })
      .from(apiChannelOutboxModel)
      .where(
        and(
          eq(apiChannelOutboxModel.inboxId, input.inboxId),
          or(
            eq(apiChannelOutboxModel.status, "pending"),
            and(
              eq(apiChannelOutboxModel.status, "leased"),
              lt(apiChannelOutboxModel.leaseExpiresAt, now),
            ),
          ),
        ),
      )
      .orderBy(apiChannelOutboxModel.createdAt, apiChannelOutboxModel.id)
      .limit(limit)
    const rows = await db
      .update(apiChannelOutboxModel)
      .set({ status: "leased", leasedAt: now, leaseExpiresAt: expires })
      .where(inArray(apiChannelOutboxModel.id, candidates))
      .returning({
        id: apiChannelOutboxModel.id,
        contactSourceId: apiChannelOutboxModel.contactSourceId,
        envelope: apiChannelOutboxModel.envelope,
        createdAt: apiChannelOutboxModel.createdAt,
        leaseExpiresAt: apiChannelOutboxModel.leaseExpiresAt,
      })
    rows.sort(
      (a, b) =>
        a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1),
    )
    return rows
  }

  /**
   * Settle a leased (or still pending, if the worker answers from a stale
   * lease) row with the worker's answer. Scoped to the inbox the token
   * belongs to, so one inbox's token cannot settle another's rows.
   */
  async ack(input: {
    inboxId: string
    id: string
    ack: OutboxAck
    now?: Date
  }): Promise<OutboxAckOutcome> {
    const now = input.now ?? new Date()
    const status = isRefusal(input.ack) ? "refused" : "acked"
    const [row] = await db
      .update(apiChannelOutboxModel)
      .set({ status, ackedAt: now, result: { ...input.ack } })
      .where(
        and(
          eq(apiChannelOutboxModel.id, input.id),
          eq(apiChannelOutboxModel.inboxId, input.inboxId),
          inArray(apiChannelOutboxModel.status, ["pending", "leased"]),
        ),
      )
      .returning({ contactSourceId: apiChannelOutboxModel.contactSourceId })
    if (row) {
      return { outcome: status, contactSourceId: row.contactSourceId }
    }
    const [existing] = await db
      .select({ id: apiChannelOutboxModel.id })
      .from(apiChannelOutboxModel)
      .where(
        and(
          eq(apiChannelOutboxModel.id, input.id),
          eq(apiChannelOutboxModel.inboxId, input.inboxId),
        ),
      )
      .limit(1)
    return { outcome: existing ? "already-settled" : "not-found" }
  }
}

export const apiChannelOutboxService = new ApiChannelOutboxService()
