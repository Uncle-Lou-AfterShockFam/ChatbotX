// @vitest-environment node

import { beforeEach, describe, expect, test, vi } from "vitest"

const { selectLimit, insertReturning, insertValues, deleteReturning, where } =
  vi.hoisted(() => ({
    selectLimit: vi.fn(),
    insertReturning: vi.fn(),
    insertValues: vi.fn(),
    deleteReturning: vi.fn(),
    where: vi.fn(),
  }))

vi.mock("@chatbotx.io/database/client", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (w: unknown) => {
          where(w)
          return {
            limit: (n: number) => selectLimit(n),
            orderBy: () => ({ limit: (n: number) => selectLimit(n) }),
          }
        },
      }),
    }),
    insert: () => ({
      values: (v: unknown) => {
        insertValues(v)
        return {
          onConflictDoNothing: () => ({ returning: () => insertReturning() }),
        }
      },
    }),
    delete: () => ({
      where: (w: unknown) => {
        where(w)
        return { returning: () => deleteReturning() }
      },
    }),
  },
  and: (...a: unknown[]) => ({ and: a }),
  eq: (...a: unknown[]) => ({ eq: a }),
  lt: (...a: unknown[]) => ({ lt: a }),
  desc: (a: unknown) => ({ desc: a }),
  inArray: (...a: unknown[]) => ({ inArray: a }),
}))
vi.mock("@chatbotx.io/database/schema", () => ({
  emailSuppressionModel: {
    id: "id",
    workspaceId: "workspaceId",
    value: "value",
  },
}))
vi.mock("@chatbotx.io/utils", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createId: () => "sup_new",
}))
vi.mock("@chatbotx.io/redis", () => ({ invalidateCacheByTags: vi.fn() }))
vi.mock("../src/audit/dispatcher", () => ({ dispatchAuditRecord: vi.fn() }))

const { emailSuppressionService } = await import(
  "../src/email-suppression/service"
)

beforeEach(() => {
  vi.clearAllMocks()
  selectLimit.mockResolvedValue([])
})

describe("isSuppressed (s224b)", () => {
  test("looks up the exact address AND its @domain, in the caller's workspace only", async () => {
    selectLimit.mockResolvedValueOnce([{ id: "1" }])
    await expect(
      emailSuppressionService.isSuppressed({
        workspaceId: "ws-1",
        address: " Jane@Example.com",
      }),
    ).resolves.toBe(true)
    expect(where).toHaveBeenCalledWith({
      and: [
        { eq: ["workspaceId", "ws-1"] },
        { inArray: ["value", ["jane@example.com", "@example.com"]] },
      ],
    })
    await expect(
      emailSuppressionService.isSuppressed({
        workspaceId: "ws-1",
        address: "jane@example.com",
      }),
    ).resolves.toBe(false)
  })

  test("an address that does not parse is suppressed WITHOUT a lookup (fail closed)", async () => {
    for (const address of [null, "", "nope", "@example.com", "a@b@c.com", 5]) {
      await expect(
        emailSuppressionService.isSuppressed({ workspaceId: "ws-1", address }),
      ).resolves.toBe(true)
    }
    expect(selectLimit).not.toHaveBeenCalled()
  })

  test("a lookup error propagates (never read as not-suppressed)", async () => {
    selectLimit.mockRejectedValueOnce(new Error("db down"))
    await expect(
      emailSuppressionService.isSuppressed({
        workspaceId: "ws-1",
        address: "a@b.com",
      }),
    ).rejects.toThrow("db down")
  })
})

describe("add / remove / list (s224b)", () => {
  test("add stores the parsed value and kind; a duplicate returns the existing row", async () => {
    insertReturning.mockResolvedValueOnce([{ id: "sup_new" }])
    await emailSuppressionService.add({
      workspaceId: "ws-1",
      value: "@Blocked.com",
      userId: "u-1",
    })
    expect(insertValues).toHaveBeenCalledWith({
      id: "sup_new",
      workspaceId: "ws-1",
      value: "@blocked.com",
      kind: "domain",
      reason: "manual",
      source: null,
      createdById: "u-1",
    })
    insertReturning.mockResolvedValueOnce([])
    selectLimit.mockResolvedValueOnce([{ id: "old" }])
    await expect(
      emailSuppressionService.add({
        workspaceId: "ws-1",
        value: "@blocked.com",
      }),
    ).resolves.toEqual({ id: "old" })
  })

  test("an invalid value is a 422 on `value`, nothing written", async () => {
    for (const value of ["", "blocked.com", "a b@c.com", null, {}]) {
      await expect(
        emailSuppressionService.add({ workspaceId: "ws-1", value }),
      ).rejects.toMatchObject({ httpStatusCode: 422, field: "value" })
    }
    expect(insertValues).not.toHaveBeenCalled()
  })

  test("remove is scoped to the workspace; a miss is a 404", async () => {
    deleteReturning.mockResolvedValueOnce([])
    await expect(
      emailSuppressionService.remove({ workspaceId: "ws-2", id: "sup_1" }),
    ).rejects.toMatchObject({ httpStatusCode: 404 })
    expect(where).toHaveBeenCalledWith({
      and: [{ eq: ["id", "sup_1"] }, { eq: ["workspaceId", "ws-2"] }],
    })
  })

  test("list caps the page at 100, pages by id, and refuses a junk cursor", async () => {
    selectLimit.mockImplementationOnce(async (n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: String(1000 - i) })),
    )
    const page = await emailSuppressionService.list({
      workspaceId: "ws-1",
      limit: 10_000,
    })
    expect(page.items).toHaveLength(100)
    expect(page.nextCursor).toBe("901")
    await emailSuppressionService.list({ workspaceId: "ws-1", cursor: "901" })
    expect(where).toHaveBeenLastCalledWith({
      and: [{ eq: ["workspaceId", "ws-1"] }, { lt: ["id", "901"] }],
    })
    for (const cursor of ["1 or 1=1", "-1", "abc", "1".repeat(20)]) {
      await expect(
        emailSuppressionService.list({ workspaceId: "ws-1", cursor }),
      ).rejects.toMatchObject({ httpStatusCode: 422 })
    }
  })
})
