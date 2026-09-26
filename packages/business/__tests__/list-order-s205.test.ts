import { beforeEach, describe, expect, test, vi } from "vitest"

// s205: the builder now pages "load all" lists 50 rows at a time. Offset
// pages need a stable ORDER BY, and pageCount must use the capped limit.

const mocks = vi.hoisted(() => ({
  inboxFindMany: vi.fn(),
  memberFindMany: vi.fn(),
  count: vi.fn(),
}))

vi.mock("@chatbotx.io/database/client", () => ({
  db: {
    query: {
      inboxModel: { findMany: mocks.inboxFindMany },
      workspaceMemberModel: { findMany: mocks.memberFindMany },
    },
    $count: mocks.count,
  },
  relationsFilterToSQL: vi.fn(),
}))

const { inboxService } = await import("../src/inbox/service")
const { workspaceMemberService } = await import(
  "../src/workspace-member/service"
)

beforeEach(() => {
  vi.clearAllMocks()
  mocks.inboxFindMany.mockResolvedValue([])
  mocks.memberFindMany.mockResolvedValue([])
  mocks.count.mockResolvedValue(120)
})

describe("inboxService.list", () => {
  test("orders by id and clamps the page to 50", async () => {
    await inboxService.list({ workspaceId: "1", page: 2, perPage: 999_999_999 })

    expect(mocks.inboxFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { id: "asc" },
        limit: 50,
        offset: 50,
      }),
    )
  })

  test("pageCount uses the clamped limit, not the requested perPage", async () => {
    const result = await inboxService.list({
      workspaceId: "1",
      perPage: 999_999_999,
    })

    expect(result.pageCount).toBe(3)
  })

  test("pageCount with no perPage uses the default page of 20", async () => {
    const result = await inboxService.list({ workspaceId: "1" })

    expect(result.pageCount).toBe(6)
  })
})

describe("workspaceMemberService.listPaginated", () => {
  test("orders by id so offset pages never overlap", async () => {
    await workspaceMemberService.listPaginated({
      workspaceId: "1",
      page: 3,
      perPage: 50,
    })

    expect(mocks.memberFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { id: "asc" },
        limit: 50,
        offset: 100,
      }),
    )
  })
})
