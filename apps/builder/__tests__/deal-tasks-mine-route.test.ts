// @vitest-environment node

import { describe, expect, test, vi } from "vitest"

/**
 * s198 "My tasks": the route sits behind the contacts-access middleware, the
 * assignee is ALWAYS the caller (the viewer built from `context`), and the
 * query schema is closed, so a caller-supplied assignee is refused rather
 * than silently ignored.
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
const listMine = vi.fn(async () => ({ data: [], nextCursor: null }))
vi.mock("@chatbotx.io/business/deal-task", () => ({
  dealTaskService: { listMine },
  dealTaskTemplateService: {},
}))

await import("../src/features/deal-tasks/api/private")
const { listMyTasksQuery } = await import(
  "../src/features/deal-tasks/schema/action"
)

const route = () => {
  const p = captured.find((c) => c.route.path.endsWith("/tasks/mine"))
  if (!p?.handler) {
    throw new Error("GET /tasks/mine not captured")
  }
  return p
}

describe("GET /workspaces/{workspaceId}/tasks/mine (s198)", () => {
  test("is a GET behind the contacts-access middleware", () => {
    expect(route().route.method).toBe("GET")
    expect(route().uses).toEqual([MW])
  })

  test("the viewer (and so the assignee) comes from the context, never the input", async () => {
    const context = {
      user: { id: "u-1" },
      member: { permissions: { superAdmin: false } },
    }
    await route().handler?.({
      context,
      input: { workspaceId: "1", status: "done", cursor: "c", limit: 5 },
    })
    expect(listMine).toHaveBeenCalledWith({
      workspaceId: "1",
      status: "done",
      cursor: "c",
      limit: 5,
      viewer: { userId: "u-1", permissions: { superAdmin: false } },
    })
  })

  test("the query schema is closed: a caller-supplied assignee or user is refused", () => {
    for (const extra of [
      { assigneeId: "2" },
      { userId: "2" },
      { assignee: "any" },
    ]) {
      expect(
        listMyTasksQuery.safeParse({ workspaceId: "1", ...extra }).success,
      ).toBe(false)
    }
    expect(listMyTasksQuery.safeParse({ workspaceId: "1" }).success).toBe(true)
  })

  test("status, limit and cursor are bounded", () => {
    for (const bad of [
      { status: "all" },
      { limit: 0 },
      { limit: 101 },
      { limit: "abc" },
      { cursor: "x".repeat(257) },
    ]) {
      expect(
        listMyTasksQuery.safeParse({ workspaceId: "1", ...bad }).success,
      ).toBe(false)
    }
    expect(
      listMyTasksQuery.safeParse({ workspaceId: "1", limit: "20" }).data?.limit,
    ).toBe(20)
  })
})
