import { beforeEach, describe, expect, test, vi } from "vitest"

/**
 * crmTimelineService (s195): the parent is resolved in the workspace FIRST
 * (404 leaks nothing), unknown kinds are dropped and an all-unknown filter
 * hits no query, the page cap and the `limit + 1` lookahead drive the cursor,
 * a malformed cursor is the first page, and a viewer's pipeline visibility
 * plus owner filter reach the deal branch. Messages are never in the union.
 */
const m = vi.hoisted(() => {
  const state = {
    rows: [] as Record<string, unknown>[],
    branches: [] as unknown[][],
    orderBy: null as unknown,
    limit: null as unknown,
    unionArgs: [] as unknown[],
  }
  const makeSelect = () => {
    const self: Record<string, unknown> = {}
    const wheres: unknown[] = []
    self.from = () => self
    self.innerJoin = () => self
    self.where = (w: unknown) => {
      wheres.push(w)
      state.branches.push(wheres)
      return self
    }
    self.orderBy = (o: unknown) => {
      state.orderBy = o
      return self
    }
    self.limit = (n: unknown) => {
      state.limit = n
      return Promise.resolve(state.rows)
    }
    return self
  }
  return {
    state,
    makeSelect,
    companyFindOrFail: vi.fn(),
    listContactIds: vi.fn(async () => ["c-1", "c-2"]),
    contactFindByIdOrFail: vi.fn(),
    visibleIds: vi.fn(async () => null),
  }
})

vi.mock("@chatbotx.io/database/client", () => ({
  db: { select: () => m.makeSelect() },
  and: (...c: unknown[]) => ({ and: c }),
  eq: (f: unknown, v: unknown) => ({ eq: [f, v] }),
  inArray: (f: unknown, v: unknown) => ({ inArray: [f, v] }),
  sql: Object.assign(
    (s: TemplateStringsArray, ...v: unknown[]) => ({
      sql: s.join("?"),
      v,
      as: () => ({ sql: s.join("?"), v }),
    }),
    {},
  ),
}))
vi.mock("drizzle-orm/pg-core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  unionAll: (...q: unknown[]) => {
    m.state.unionArgs = q
    return m.makeSelect()
  },
}))
vi.mock("../src/company/service", () => ({
  companyService: {
    findOrFail: (...a: unknown[]) => m.companyFindOrFail(...a),
    listContactIds: (...a: unknown[]) => m.listContactIds(...(a as [never])),
  },
}))
vi.mock("../src/contact/service", () => ({
  contactService: {
    findByIdOrFail: (...a: unknown[]) => m.contactFindByIdOrFail(...a),
  },
}))
vi.mock("../src/pipeline/service", () => ({
  pipelineService: {
    visibleIds: (...a: unknown[]) => m.visibleIds(...(a as [never])),
  },
}))
vi.mock("../src/pipeline/access", () => ({
  viewerOwnerFilter: (viewer: { assignedOnly?: string }) => viewer.assignedOnly,
}))

import {
  crmTimelineService,
  MAX_TIMELINE_PAGE,
  timelineKinds,
} from "../src/company/timeline"

const WS = "ws-1"
const row = (i: number) => ({
  kind: "companyNote",
  id: String(1000 + i),
  at: new Date(Date.UTC(2026, 8, 24, 12, 0, i)),
  payload: {},
})

beforeEach(() => {
  vi.clearAllMocks()
  m.state.rows = []
  m.state.branches = []
  m.state.orderBy = null
  m.state.limit = null
  m.state.unionArgs = []
  m.companyFindOrFail.mockResolvedValue({ id: "co-1" })
  m.contactFindByIdOrFail.mockResolvedValue({ id: "c-1" })
})

describe("crmTimelineService.forCompany", () => {
  test("another workspace's company is a 404 before any query", async () => {
    m.companyFindOrFail.mockRejectedValueOnce(
      Object.assign(new Error("Company not found"), { code: "notFound" }),
    )
    await expect(
      crmTimelineService.forCompany({ workspaceId: "ws-x", companyId: "co-1" }),
    ).rejects.toMatchObject({ code: "notFound" })
    expect(m.state.branches).toHaveLength(0)
  })

  test("all six kinds union; the page is capped; lookahead sets the cursor", async () => {
    m.state.rows = Array.from({ length: MAX_TIMELINE_PAGE + 1 }, (_, i) =>
      row(i),
    )
    const page = await crmTimelineService.forCompany({
      workspaceId: WS,
      companyId: "co-1",
      limit: 9999,
    })
    expect(m.state.unionArgs).toHaveLength(timelineKinds.length - 1) // contactNote is contact-only
    expect(m.state.limit).toBe(MAX_TIMELINE_PAGE + 1)
    expect(page.data).toHaveLength(MAX_TIMELINE_PAGE)
    const last = page.data.at(-1) as { at: Date; id: string }
    expect(page.nextCursor).toBe(`${last.at.getTime()}:${last.id}`)
  })

  test("fewer rows than the limit = no cursor; unknown kinds are dropped, none left = no query", async () => {
    m.state.rows = [row(1)]
    const page = await crmTimelineService.forCompany({
      workspaceId: WS,
      companyId: "co-1",
      kinds: ["companyNote", "bogus"],
    })
    expect(page.nextCursor).toBeNull()
    expect(m.state.unionArgs).toHaveLength(0) // one branch: no union
    m.state.branches = []
    const empty = await crmTimelineService.forCompany({
      workspaceId: WS,
      companyId: "co-1",
      kinds: ["bogus"],
    })
    expect(empty).toEqual({ data: [], nextCursor: null })
    expect(m.state.branches).toHaveLength(0)
  })

  test("a malformed cursor is the first page; a valid one adds the keyset predicate to EVERY branch", async () => {
    m.state.rows = []
    await crmTimelineService.forCompany({
      workspaceId: WS,
      companyId: "co-1",
      cursor: "not-a-cursor",
    })
    const flat = m.state.branches.flat() as { and?: unknown[] }[]
    expect(flat.length).toBeGreaterThan(0)
    for (const w of flat) {
      expect(w.and?.at(-1)).toBeUndefined()
    }
    m.state.branches = []
    await crmTimelineService.forCompany({
      workspaceId: WS,
      companyId: "co-1",
      cursor: "1758715200000:1001",
    })
    const flat2 = m.state.branches.flat() as { and?: unknown[] }[]
    for (const w of flat2) {
      expect(w.and?.at(-1)).toMatchObject({ sql: expect.stringContaining("<") })
    }
  })

  test("the union is ordered by the OUTPUT column names, never the mapping key", async () => {
    m.state.rows = []
    await crmTimelineService.forCompany({ workspaceId: WS, companyId: "co-1" })
    const orderBy = m.state.orderBy as { sql: string }
    expect(orderBy.sql).toContain('"createdAt" desc, "id" desc')
    expect(orderBy.sql).not.toContain('"at"')
  })

  test("the keyset predicate names each branch's OWN columns (a joined branch would otherwise be ambiguous)", async () => {
    const { dealActivityModel } = await import("@chatbotx.io/database/schema")
    await crmTimelineService.forCompany({
      workspaceId: WS,
      companyId: "co-1",
      kinds: ["dealActivity"],
      cursor: "1758715200000:1001",
    })
    const [w] = m.state.branches.flat() as { and: { v?: unknown[] }[] }[]
    const pred = w.and.at(-1) as { v: unknown[] }
    expect(pred.v[0]).toBe(dealActivityModel.createdAt)
    expect(pred.v[1]).toBe(dealActivityModel.id)
  })

  test("a viewer with no visible pipeline gets a dead deal branch; an assigned-only viewer is owner-pinned", async () => {
    m.visibleIds.mockResolvedValueOnce([])
    await crmTimelineService.forCompany({
      workspaceId: WS,
      companyId: "co-1",
      kinds: ["dealActivity"],
      viewer: { userId: "u-1", permissions: {} } as never,
    })
    expect(m.visibleIds).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS }),
    )
    const [dealWhere] = m.state.branches.flat() as { and: unknown[] }[]
    expect(dealWhere.and[1]).toMatchObject({ sql: "false" })
    m.state.branches = []
    m.visibleIds.mockResolvedValueOnce(["p-1"])
    await crmTimelineService.forCompany({
      workspaceId: WS,
      companyId: "co-1",
      kinds: ["dealActivity"],
      viewer: { userId: "u-1", permissions: {}, assignedOnly: "u-1" } as never,
    })
    const [w2] = m.state.branches.flat() as { and: unknown[] }[]
    expect(w2.and[1]).toMatchObject({ inArray: [expect.anything(), ["p-1"]] })
    expect(w2.and[2]).toMatchObject({ eq: [expect.anything(), "u-1"] })
  })
})

describe("crmTimelineService.forContact", () => {
  test("resolves the contact in the workspace first; contact notes replace company branches", async () => {
    m.contactFindByIdOrFail.mockRejectedValueOnce(
      Object.assign(new Error("Contact not found"), { code: "notFound" }),
    )
    await expect(
      crmTimelineService.forContact({ workspaceId: WS, contactId: "c-9" }),
    ).rejects.toMatchObject({ code: "notFound" })
    m.state.rows = []
    await crmTimelineService.forContact({ workspaceId: WS, contactId: "c-1" })
    // contactNote + dealActivity + submission + appointment
    expect(m.state.unionArgs).toHaveLength(4)
    expect(m.listContactIds).not.toHaveBeenCalled()
  })
})
