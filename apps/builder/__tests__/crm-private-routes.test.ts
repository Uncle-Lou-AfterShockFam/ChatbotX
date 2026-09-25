// @vitest-environment node

import { describe, expect, test, vi } from "vitest"

/**
 * s195 Contact / Company 360 routes: every route sits behind the
 * contacts-access middleware; every route that returns deals or deal-derived
 * rows passes the viewer built from `context.member`; every contact route
 * resolves the contact inside the caller's assigned-only scope BEFORE reading;
 * unlinking a contact that is not on the company touches nothing.
 */
type Captured = {
  route: { method: string; path: string }
  uses: unknown[]
  handler?: (args: unknown) => unknown
}
const { captured } = vi.hoisted(() => ({ captured: [] as Captured[] }))
vi.mock("@/orpc", () => {
  const make = () => {
    const entry: Captured = { route: { method: "", path: "" }, uses: [] }
    const chain: Record<string, unknown> = {}
    chain.route = (r: Captured["route"]) => {
      entry.route = r
      return chain
    }
    for (const k of ["input", "output", "errors"]) {
      chain[k] = () => chain
    }
    chain.use = (mw: unknown) => {
      entry.uses.push(mw)
      return chain
    }
    chain.handler = (fn: (a: unknown) => unknown) => {
      entry.handler = fn
      captured.push(entry)
      return chain
    }
    return chain
  }
  return {
    authorizedAPI: {
      route: (r: Captured["route"]) =>
        (make().route as (r: unknown) => unknown)(r),
    },
  }
})
const MW = Symbol("contactsAccessAuthorizedMiddleware")
vi.mock("@/middlewares/auth", () => ({
  contactsAccessAuthorizedMiddleware: MW,
}))
const SCOPE = { canViewEmailAndPhone: true, restrictToAssignedUserId: "u-1" }
const requireContactPermissionScope = vi.fn(async () => SCOPE)
vi.mock("@/features/contacts/permissions", () => ({
  requireContactPermissionScope,
}))
const proxy = (dflt: () => unknown) =>
  new Proxy({} as Record<string, ReturnType<typeof vi.fn>>, {
    get: (t, k: string) => (t[k] ??= vi.fn(async () => dflt())),
  })
const dealService = proxy(() => ({
  data: [{ id: "d-1", status: "open", value: "10.50", currency: "USD" }],
  pageCount: 1,
}))
const dealTaskService = proxy(() => [])
const companyService = proxy(() => ({ id: "co-1" }))
companyService.countContacts.mockImplementation(async () => new Map())
const companyNoteService = proxy(() => ({ id: "n-1" }))
const companyActivityService = proxy(() => [])
const conversationService = proxy(() => [])
const crmTimelineService = proxy(() => ({ data: [], nextCursor: null }))
const questionnaireSubmissionService = proxy(() => [])
vi.mock("@chatbotx.io/business/deal", () => ({ dealService }))
vi.mock("@chatbotx.io/business/deal-task", () => ({ dealTaskService }))
vi.mock("@chatbotx.io/business", () => ({
  companyService,
  companyNoteService,
  companyActivityService,
  conversationService,
  crmTimelineService,
  questionnaireSubmissionService,
}))

await import("../src/features/crm/api/private")

const context = {
  user: { id: "u-1" },
  member: { permissions: { superAdmin: false, onlyAssignedContacts: true } },
}
const VIEWER = {
  userId: "u-1",
  permissions: { superAdmin: false, onlyAssignedContacts: true },
}
const input = {
  workspaceId: "ws-1",
  id: "co-1",
  contactId: "c-1",
  noteId: "n-1",
  text: "hi",
  limit: 5,
}
const find = (method: string, path: string) => {
  const p = captured.find(
    (c) => c.route.method === method && c.route.path.endsWith(path),
  )
  if (!p?.handler) {
    throw new Error(`route ${method} ${path} not captured`)
  }
  return p
}

describe("crm private routes (s195)", () => {
  test("16 routes, all behind the contacts-access middleware", () => {
    expect(captured).toHaveLength(16)
    for (const p of captured) {
      expect(p.uses, `${p.route.method} ${p.route.path}`).toEqual([MW])
    }
  })

  test("deal-derived company reads pass the viewer to dealService.list and the task rollup", async () => {
    for (const path of ["/companies/{id}/deals", "/companies/{id}/metrics"]) {
      dealService.list.mockClear()
      await find("GET", path).handler?.({ context, input })
      expect(dealService.list, path).toHaveBeenCalledWith(
        expect.objectContaining({
          companyId: "co-1",
          viewer: VIEWER,
          perPage: 200,
        }),
      )
    }
    // s197: the task rollup filters by the company IN its scoped query, not
    // by the ids of dealService.list's first page (capped at 50 deals)
    expect(dealTaskService.listForDealsOf).toHaveBeenLastCalledWith(
      expect.objectContaining({
        parent: { companyId: "co-1" },
        viewer: VIEWER,
      }),
    )
    dealService.list.mockClear()
    await find("GET", "/companies/{id}/tasks").handler?.({ context, input })
    expect(dealService.list).not.toHaveBeenCalled()
    expect(dealTaskService.listForDealsOf).toHaveBeenLastCalledWith(
      expect.objectContaining({
        parent: { companyId: "co-1" },
        viewer: VIEWER,
      }),
    )
    expect(crmTimelineService.forCompany).toHaveBeenLastCalledWith(
      expect.objectContaining({ companyId: "co-1", viewer: VIEWER, limit: 1 }),
    )
  })

  test("metrics sums numeric strings exactly PER CURRENCY and counts overdue open tasks", async () => {
    const now = Date.now()
    dealService.list.mockResolvedValueOnce({
      data: [
        { id: "d-1", status: "open", value: "10.50", currency: "USD" },
        { id: "d-2", status: "open", value: "0.75", currency: "USD" },
        { id: "d-3", status: "won", value: "1000", currency: "USD" },
        { id: "d-4", status: "lost", value: "5", currency: "USD" },
        { id: "d-5", status: "open", value: null, currency: "USD" },
        { id: "d-6", status: "open", value: "99.5", currency: "EUR" },
        { id: "d-7", status: "won", value: "-1.05", currency: "EUR" },
      ],
      pageCount: 1,
    })
    dealTaskService.listForDealsOf.mockResolvedValueOnce([
      { status: "open", dueAt: new Date(now - 1000) },
      { status: "open", dueAt: new Date(now + 1000) },
      { status: "open", dueAt: null },
      { status: "done", dueAt: new Date(now - 1000) },
    ])
    companyService.countContacts.mockResolvedValueOnce(new Map([["co-1", 3]]))
    const out = (await find("GET", "/companies/{id}/metrics").handler?.({
      context,
      input,
    })) as Record<string, unknown>
    expect(out).toMatchObject({
      contacts: 3,
      openDeals: 4,
      openValue: { USD: "11.25", EUR: "99.50" },
      wonValue: { USD: "1000.00", EUR: "-1.05" },
      openTasks: 3,
      overdueTasks: 1,
      lastActivityAt: null,
    })
  })

  test("company timeline forwards kinds / cursor / limit with the viewer and the scope", async () => {
    await find("GET", "/companies/{id}/timeline").handler?.({
      context,
      input: { ...input, kinds: ["companyNote"], cursor: "1:2", limit: 7 },
    })
    expect(crmTimelineService.forCompany).toHaveBeenLastCalledWith({
      workspaceId: "ws-1",
      companyId: "co-1",
      kinds: ["companyNote"],
      cursor: "1:2",
      limit: 7,
      viewer: VIEWER,
      accessScope: SCOPE,
    })
  })

  test("notes: create stamps the caller, delete passes the actor, both scoped by company", async () => {
    await find("POST", "/companies/{id}/notes").handler?.({ context, input })
    expect(companyNoteService.create).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      companyId: "co-1",
      text: "hi",
      createdById: "u-1",
    })
    await find("DELETE", "/companies/{id}/notes/{noteId}").handler?.({
      context,
      input,
    })
    expect(companyNoteService.delete).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      companyId: "co-1",
      noteId: "n-1",
      actorId: "u-1",
    })
  })

  test("unlink: the contact is resolved in the caller's scope, then cleared PINNED to this company", async () => {
    crmTimelineService.assertContact.mockClear()
    await find("DELETE", "/companies/{id}/contacts/{contactId}").handler?.({
      context,
      input,
    })
    expect(crmTimelineService.assertContact).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      contactId: "c-1",
      accessScope: SCOPE,
    })
    expect(companyService.assignContact).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      contactId: "c-1",
      companyId: null,
      expectedCompanyId: "co-1",
      actorId: "u-1",
    })
  })

  test("company rollups of contact data carry the caller's assigned-only scope", async () => {
    for (const path of [
      "/companies/{id}/conversations",
      "/companies/{id}/submissions",
    ]) {
      companyService.listContactIds.mockClear()
      await find("GET", path).handler?.({ context, input })
      expect(companyService.listContactIds, path).toHaveBeenCalledWith(
        expect.objectContaining({ companyId: "co-1", accessScope: SCOPE }),
      )
    }
    await find("GET", "/companies/{id}/timeline").handler?.({ context, input })
    expect(crmTimelineService.forCompany).toHaveBeenLastCalledWith(
      expect.objectContaining({ accessScope: SCOPE }),
    )
    await find("GET", "/companies/{id}/metrics").handler?.({ context, input })
    expect(companyService.countContacts).toHaveBeenLastCalledWith(
      expect.objectContaining({ accessScope: SCOPE }),
    )
  })

  test("every contact route resolves the contact in the assigned-only scope first", async () => {
    for (const path of [
      "/contacts/{contactId}/submissions",
      "/contacts/{contactId}/tasks",
      "/contacts/{contactId}/conversation",
    ]) {
      crmTimelineService.assertContact.mockClear()
      await find("GET", path).handler?.({ context, input })
      expect(crmTimelineService.assertContact, path).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        contactId: "c-1",
        accessScope: SCOPE,
      })
    }
    await find("GET", "/contacts/{contactId}/timeline").handler?.({
      context,
      input,
    })
    expect(dealTaskService.listForDealsOf).toHaveBeenCalledWith(
      expect.objectContaining({ parent: { contactId: "c-1" }, viewer: VIEWER }),
    )
    expect(crmTimelineService.forContact).toHaveBeenLastCalledWith(
      expect.objectContaining({
        contactId: "c-1",
        viewer: VIEWER,
        accessScope: SCOPE,
      }),
    )
    // a scope failure propagates before any read
    crmTimelineService.assertContact.mockRejectedValueOnce(new Error("nope"))
    questionnaireSubmissionService.listByContactIds.mockClear()
    await expect(
      find("GET", "/contacts/{contactId}/submissions").handler?.({
        context,
        input,
      }),
    ).rejects.toThrow("nope")
    expect(
      questionnaireSubmissionService.listByContactIds,
    ).not.toHaveBeenCalled()
  })

  test("conversations: only DM rows (sourceId null), newest activity first, contact name flattened", async () => {
    conversationService.findManyByContactIds.mockResolvedValueOnce([
      {
        id: "cv-1",
        contactId: "c-1",
        sourceId: "post-1",
        lastActivityAt: new Date(5),
        contact: { fullName: "A" },
      },
      {
        id: "cv-2",
        contactId: "c-2",
        sourceId: null,
        lastActivityAt: new Date(1),
        contact: { fullName: "B" },
      },
      {
        id: "cv-3",
        contactId: "c-3",
        sourceId: null,
        lastActivityAt: new Date(9),
        contact: null,
      },
    ])
    const out = (await find("GET", "/companies/{id}/conversations").handler?.({
      context,
      input,
    })) as { data: { id: string; contactName: string | null }[] }
    expect(out.data.map((r) => [r.id, r.contactName])).toEqual([
      ["cv-3", null],
      ["cv-2", "B"],
    ])
  })
})
