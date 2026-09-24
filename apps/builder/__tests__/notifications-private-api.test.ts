// @vitest-environment node

import { describe, expect, test, vi } from "vitest"

/**
 * s194: every private notifications route scopes on `context.user.id` (the
 * viewer's OWN rows: a foreign id is a `marked: false`, never a 403) and
 * gates on plain workspace membership, not the contacts section.
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
const MW = Symbol("workspaceAuthorizedMidddleware")
vi.mock("@/middlewares/auth", () => ({
  workspaceAuthorizedMidddleware: MW,
  contactsAccessAuthorizedMiddleware: Symbol("contacts"),
}))
const notificationService = {
  list: vi.fn(async () => ({ data: [], nextCursor: null })),
  countUnread: vi.fn(async () => 3),
  markRead: vi.fn(async () => ({ marked: false })),
  markAllRead: vi.fn(async () => ({ count: 0 })),
}
vi.mock("@chatbotx.io/business/notification", () => ({ notificationService }))

await import("../src/features/notifications/api/private")

const context = { user: { id: "u-1" }, member: { permissions: {} } }
const byPath = (method: string, suffix: string) => {
  const p = captured.find(
    (c) => c.route.method === method && c.route.path.endsWith(suffix),
  )
  if (!p) {
    throw new Error(`no route ${method} ...${suffix}`)
  }
  return p
}

describe("private notifications routes (s194)", () => {
  test("four routes, every one on the workspace-membership middleware", () => {
    expect(captured.map((c) => `${c.route.method} ${c.route.path}`)).toEqual([
      "GET /workspaces/{workspaceId}/notifications",
      "GET /workspaces/{workspaceId}/notifications/unread-count",
      "POST /workspaces/{workspaceId}/notifications/{id}/read",
      "POST /workspaces/{workspaceId}/notifications/read-all",
    ])
    for (const p of captured) {
      expect(p.uses).toEqual([MW])
    }
  })

  test("list passes the viewer's id, cursor, limit and unreadOnly", async () => {
    await byPath("GET", "/notifications").handler?.({
      context,
      input: { workspaceId: "ws-1", cursor: "9", limit: 5, unreadOnly: true },
    })
    expect(notificationService.list).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      userId: "u-1",
      cursor: "9",
      limit: 5,
      unreadOnly: true,
    })
  })

  test("unread-count wraps the number", async () => {
    await expect(
      byPath("GET", "/unread-count").handler?.({
        context,
        input: { workspaceId: "ws-1" },
      }),
    ).resolves.toEqual({ count: 3 })
    expect(notificationService.countUnread).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      userId: "u-1",
    })
  })

  test("mark read / read-all scope on the viewer, a foreign id is marked:false", async () => {
    await expect(
      byPath("POST", "/{id}/read").handler?.({
        context,
        input: { workspaceId: "ws-1", id: "77" },
      }),
    ).resolves.toEqual({ marked: false })
    expect(notificationService.markRead).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      userId: "u-1",
      id: "77",
    })
    await byPath("POST", "/read-all").handler?.({
      context,
      input: { workspaceId: "ws-1" },
    })
    expect(notificationService.markAllRead).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      userId: "u-1",
    })
  })
})
