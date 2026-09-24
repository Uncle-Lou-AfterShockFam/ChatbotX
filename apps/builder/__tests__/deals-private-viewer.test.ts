// @vitest-environment node

import { describe, expect, test, vi } from "vitest"

/**
 * s193: every private deals / pipelines / deal-tasks route hands the business
 * layer a `viewer` built from the SAME member row the contacts-access
 * middleware resolved (`context.member`), so scoping cannot drift from the
 * permission gate. Pinned: the viewer shape, and that every captured handler
 * of the three routers passes one.
 */
type Captured = {
  route: { method: string; path: string }
  uses: unknown[]
  handler?: (args: unknown) => unknown
}
const { captured } = vi.hoisted(() => {
  const captured: Captured[] = []
  return { captured }
})
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
const dealService = new Proxy({} as Record<string, ReturnType<typeof vi.fn>>, {
  get: (t, k: string) => (t[k] ??= vi.fn(async () => ({ data: [] }))),
})
const pipelineService = new Proxy(
  {} as Record<string, ReturnType<typeof vi.fn>>,
  { get: (t, k: string) => (t[k] ??= vi.fn(async () => [])) },
)
const dealTaskService = new Proxy(
  {} as Record<string, ReturnType<typeof vi.fn>>,
  { get: (t, k: string) => (t[k] ??= vi.fn(async () => ({ id: "t" }))) },
)
const pipelineMemberService = { list: vi.fn(async () => []), set: vi.fn() }
vi.mock("@chatbotx.io/business/deal", () => ({ dealService }))
vi.mock("@chatbotx.io/business", () => ({
  pipelineService,
  pipelineMemberService,
}))
const dealTaskTemplateService = new Proxy(
  {} as Record<string, ReturnType<typeof vi.fn>>,
  { get: (t, k: string) => (t[k] ??= vi.fn(async () => [])) },
)
vi.mock("@chatbotx.io/business/deal-task", () => ({
  dealTaskService,
  dealTaskTemplateService,
}))

await import("../src/features/deals/api/private")
await import("../src/features/pipelines/api/private")
await import("../src/features/deal-tasks/api/private")

const context = {
  user: { id: "u-1" },
  member: { permissions: { superAdmin: false, onlyAssignedContacts: true } },
}
const UNSCOPED =
  /^(POST|PUT|DELETE) \/workspaces\/\{workspaceId\}\/pipelines(\/\{id\}|\/\{pipelineId\})?(\/stages.*)?$/
const VIEWER = {
  userId: "u-1",
  permissions: { superAdmin: false, onlyAssignedContacts: true },
}

describe("private deal routes carry the viewer (s193)", () => {
  test("every route uses the contacts-access middleware", () => {
    expect(captured.length).toBeGreaterThan(20)
    for (const p of captured) {
      expect(p.uses, `${p.route.method} ${p.route.path}`).toContain(MW)
    }
  })

  test("every deal / pipeline read or write receives viewer = {userId, member.permissions}", async () => {
    const services = [
      dealService,
      pipelineService,
      dealTaskService,
      dealTaskTemplateService,
    ]
    const skipped: string[] = []
    for (const p of captured) {
      const before = services.flatMap((s) =>
        Object.values(s).map((fn) => fn.mock.calls.length),
      )
      await p.handler?.({
        context,
        input: {
          workspaceId: "ws-1",
          id: "1",
          pipelineId: "1",
          stageId: "1",
          taskId: "1",
          dependsOnTaskId: "2",
          ids: ["1"],
          members: [],
          stageIds: ["1"],
          text: "x",
          status: "won",
          title: "x",
        },
      })
      const calls = services.flatMap((s) =>
        Object.values(s).flatMap((fn) => fn.mock.calls.map((c) => c[0])),
      )
      const after = services.flatMap((s) =>
        Object.values(s).map((fn) => fn.mock.calls.length),
      )
      if (before.join() === after.join()) {
        skipped.push(`${p.route.method} ${p.route.path}`)
        continue
      }
      const last = calls.at(-1) as Record<string, unknown>
      const name = `${p.route.method} ${p.route.path}`
      // Pipeline MANAGEMENT (create / rename / delete / stages / task
      // templates / members) is unscoped by design: a members-only pipeline
      // is configured by the people who can already see it in Settings.
      if (UNSCOPED.test(name) || name.includes("task-templates")) {
        expect(last, name).not.toHaveProperty("viewer")
        continue
      }
      expect(last, name).toMatchObject({ viewer: VIEWER })
    }
    expect(skipped).toEqual([])
  })
})
