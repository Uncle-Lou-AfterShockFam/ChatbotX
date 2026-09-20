// @vitest-environment node

import { describe, expect, test, vi } from "vitest"

const { mockUpdateWhere, mockReturning, mockInsertValues } = vi.hoisted(() => ({
  mockUpdateWhere: vi.fn(),
  mockReturning: vi.fn(),
  mockInsertValues: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("@chatbotx.io/database/client", () => ({
  db: {
    insert: () => ({ values: mockInsertValues }),
    update: () => ({
      set: () => ({
        where: (w: unknown) => ({ returning: () => mockUpdateWhere(w) }),
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => mockReturning(),
          orderBy: () => ({
            limit: () => ({ for: () => "candidates" }),
          }),
        }),
      }),
    }),
  },
  and: (...a: unknown[]) => ({ and: a }),
  or: (...a: unknown[]) => ({ or: a }),
  eq: (...a: unknown[]) => ({ eq: a }),
  lt: (...a: unknown[]) => ({ lt: a }),
  inArray: (...a: unknown[]) => ({ inArray: a }),
  sql: Object.assign(() => ({ mapWith: () => "sql" }), {}),
}))

vi.mock("@chatbotx.io/database/schema", () => ({
  apiChannelOutboxModel: {
    id: "id",
    inboxId: "inboxId",
    status: "status",
    createdAt: "createdAt",
    leaseExpiresAt: "leaseExpiresAt",
    ackedAt: "ackedAt",
    contactSourceId: "contactSourceId",
    envelope: "envelope",
  },
}))

vi.mock("@chatbotx.io/utils", () => ({ createId: () => "ob_new" }))
vi.mock("@chatbotx.io/redis", () => ({ invalidateCacheByTags: vi.fn() }))
vi.mock("../src/audit/dispatcher", () => ({ dispatchAuditRecord: vi.fn() }))

const { apiChannelOutboxService, isRefusal, normalizeAck, OUTBOX_MAX_PULL } =
  await import("../src/api-channel-outbox/service")

describe("isRefusal — the push-mode callback contract, mirrored", () => {
  test("a non-empty reason refuses, except suppressed with a message id", () => {
    expect(isRefusal({})).toBe(false)
    expect(isRefusal({ reason: null })).toBe(false)
    expect(isRefusal({ reason: "" })).toBe(false)
    expect(isRefusal({ messageId: "msg:1" })).toBe(false)
    expect(isRefusal({ reason: "bad-options" })).toBe(true)
    expect(isRefusal({ reason: "duplicate", messageId: "msg:1" })).toBe(true)
    expect(isRefusal({ reason: "suppressed", messageId: "hook:1" })).toBe(false)
    expect(isRefusal({ reason: "suppressed" })).toBe(true)
    expect(isRefusal({ reason: "suppressed", messageId: "" })).toBe(true)
  })
})

describe("normalizeAck — closed, bounded", () => {
  test("keeps the three known string keys, drops nulls, refuses anything else", () => {
    expect(
      normalizeAck({ messageId: "m", reason: null, warning: undefined }),
    ).toEqual({ messageId: "m" })
    expect(normalizeAck({})).toEqual({})
    expect(() => normalizeAck(null)).toThrow("object")
    expect(() => normalizeAck([])).toThrow("object")
    expect(() => normalizeAck("x")).toThrow("object")
    expect(() => normalizeAck({ extra: 1 })).toThrow("unknown key extra")
    expect(() => normalizeAck({ reason: 5 })).toThrow("reason must be a string")
    expect(() => normalizeAck({ warning: "x".repeat(501) })).toThrow(
      "at most 500",
    )
    expect(normalizeAck({ warning: "x".repeat(500) })).toEqual({
      warning: "x".repeat(500),
    })
  })
})

describe("service", () => {
  test("enqueue refuses an empty contact identity and otherwise inserts a pending row", async () => {
    await expect(
      apiChannelOutboxService.enqueue({
        workspaceId: "w",
        inboxId: "i",
        contactSourceId: "",
        envelope: {},
      }),
    ).rejects.toThrow("contactSourceId")
    expect(mockInsertValues).not.toHaveBeenCalled()
    const id = await apiChannelOutboxService.enqueue({
      workspaceId: "w",
      inboxId: "i",
      contactSourceId: "+15550000001",
      envelope: { event: "message_created" },
    })
    expect(id).toBe("ob_new")
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "ob_new",
        inboxId: "i",
        workspaceId: "w",
        contactSourceId: "+15550000001",
        status: "pending",
      }),
    )
  })

  test("pull clamps the limit to 1..OUTBOX_MAX_PULL and returns rows oldest first", async () => {
    const t1 = new Date("2026-09-20T08:00:00Z")
    const t2 = new Date("2026-09-20T08:00:01Z")
    mockUpdateWhere.mockResolvedValueOnce([
      {
        id: "b",
        contactSourceId: "x",
        envelope: {},
        createdAt: t2,
        leaseExpiresAt: null,
      },
      {
        id: "a",
        contactSourceId: "x",
        envelope: {},
        createdAt: t1,
        leaseExpiresAt: null,
      },
    ])
    const rows = await apiChannelOutboxService.pull({
      inboxId: "i",
      limit: 10_000,
    })
    expect(rows.map((r) => r.id)).toEqual(["a", "b"])
    expect(OUTBOX_MAX_PULL).toBe(50)
    mockUpdateWhere.mockResolvedValueOnce([])
    expect(
      await apiChannelOutboxService.pull({ inboxId: "i", limit: 0 }),
    ).toEqual([])
  })

  test("ack settles a leased row as acked or refused, scoped to the inbox; a settled or foreign row is a no-op", async () => {
    mockUpdateWhere.mockResolvedValueOnce([{ contactSourceId: "+15550000001" }])
    expect(
      await apiChannelOutboxService.ack({
        inboxId: "i",
        id: "a",
        ack: { messageId: "msg:1" },
      }),
    ).toEqual({ outcome: "acked", contactSourceId: "+15550000001" })
    mockUpdateWhere.mockResolvedValueOnce([{ contactSourceId: "+15550000001" }])
    expect(
      await apiChannelOutboxService.ack({
        inboxId: "i",
        id: "a",
        ack: { reason: "bad-options", warning: "w" },
      }),
    ).toEqual({ outcome: "refused", contactSourceId: "+15550000001" })
    mockUpdateWhere.mockResolvedValueOnce([])
    mockReturning.mockResolvedValueOnce([{ id: "a" }])
    expect(
      await apiChannelOutboxService.ack({ inboxId: "i", id: "a", ack: {} }),
    ).toEqual({ outcome: "already-settled" })
    mockUpdateWhere.mockResolvedValueOnce([])
    mockReturning.mockResolvedValueOnce([])
    expect(
      await apiChannelOutboxService.ack({ inboxId: "other", id: "a", ack: {} }),
    ).toEqual({ outcome: "not-found" })
  })
})
