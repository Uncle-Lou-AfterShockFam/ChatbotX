// @vitest-environment node

import { beforeEach, describe, expect, test, vi } from "vitest"

/**
 * s224b email suppression routes: every route sits behind the contacts-access
 * middleware (the workspace gate that refuses another workspace's caller), and
 * every service call is scoped to the ROUTE's workspaceId, never the body.
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
const service = {
  list: vi.fn(async () => ({ items: [], nextCursor: null })),
  add: vi.fn(async () => ({ id: "s-1" })),
  remove: vi.fn(async () => undefined),
}
vi.mock("@chatbotx.io/business/email-suppression", () => ({
  emailSuppressionService: service,
}))

await import("../src/features/email-suppression/api/private")
const byPath = (method: string, path: string) => {
  const entry = captured.find(
    (c) => c.route.method === method && c.route.path === path,
  )
  if (!entry?.handler) {
    throw new Error(`no route ${method} ${path}`)
  }
  return entry
}

beforeEach(() => vi.clearAllMocks())

describe("email suppression routes (s224b)", () => {
  test("all three routes exist and every one is gated by contacts access", () => {
    expect(captured).toHaveLength(3)
    for (const entry of captured) {
      expect(entry.uses).toEqual([MW])
    }
  })

  test("list, add and remove pass the route's workspace (and the caller as creator)", async () => {
    const base = "/workspaces/{workspaceId}/email-suppressions"
    await byPath("GET", base).handler?.({
      input: { workspaceId: "ws-1", cursor: "9" },
    })
    expect(service.list).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      cursor: "9",
      limit: undefined,
    })
    await byPath("POST", base).handler?.({
      input: { workspaceId: "ws-1", value: "@x.com" },
      context: { user: { id: "u-1" } },
    })
    expect(service.add).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      value: "@x.com",
      userId: "u-1",
    })
    await byPath("DELETE", `${base}/{id}`).handler?.({
      input: { workspaceId: "ws-1", id: "5" },
    })
    expect(service.remove).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      id: "5",
    })
  })
})
