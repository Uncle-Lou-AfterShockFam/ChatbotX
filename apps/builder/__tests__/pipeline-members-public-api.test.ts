// @vitest-environment node

import { describe, expect, test, vi } from "vitest"

/**
 * The s193 pipeline member routes: both on the `deals` scope, list + full
 * replace only (no per-member PATCH), and the PUT handler resolves the
 * pipeline through the UNSCOPED `pipelineService.findOrFail` (a workspace
 * token has no member row) before replacing the list.
 */
type RouteConfig = { method: string; path: string; description?: string }
const { capturedProcedures, scopes, workspaceTokenAuthAPIForScope } =
  vi.hoisted(() => {
    const capturedProcedures: {
      route: RouteConfig
      handler?: (args: unknown) => unknown
    }[] = []
    const scopes: string[] = []
    const makeProcedure = (route: RouteConfig) => {
      const entry: { route: RouteConfig; handler?: (a: unknown) => unknown } = {
        route,
      }
      const chain: Record<string, unknown> = {}
      for (const k of ["input", "output", "errors"]) {
        chain[k] = () => chain
      }
      chain.handler = (fn: (a: unknown) => unknown) => {
        entry.handler = fn
        return chain
      }
      capturedProcedures.push(entry)
      return chain
    }
    return {
      capturedProcedures,
      scopes,
      workspaceTokenAuthAPIForScope: vi.fn((scope: string) => {
        scopes.push(scope)
        return { route: (config: RouteConfig) => makeProcedure(config) }
      }),
    }
  })
const pipelineService = { findOrFail: vi.fn() }
const pipelineMemberService = { list: vi.fn(), set: vi.fn() }
vi.mock("@/orpc", () => ({ workspaceTokenAuthAPIForScope }))
vi.mock("@chatbotx.io/business", () => ({
  pipelineService,
  pipelineMemberService,
}))

await import("../src/features/pipelines/api/public")

const member = (method: string) =>
  capturedProcedures.find(
    (p) =>
      p.route.method === method &&
      p.route.path === "/v1/pipelines/{id}/members",
  )

describe("pipeline members public API (s193)", () => {
  test("GET + PUT /v1/pipelines/{id}/members exist on the deals scope with >= 50-char descriptions", () => {
    expect(new Set(scopes)).toEqual(new Set(["deals"]))
    for (const method of ["GET", "PUT"]) {
      const route = member(method)
      expect(route, method).toBeDefined()
      expect(route?.route.description?.length ?? 0).toBeGreaterThanOrEqual(50)
    }
    expect(
      capturedProcedures.filter((p) => p.route.path.includes("/members")),
    ).toHaveLength(2)
  })

  test("PUT resolves the pipeline WITHOUT a viewer, then replaces the list with the given members", async () => {
    pipelineService.findOrFail.mockResolvedValueOnce({ id: "p1" })
    pipelineMemberService.set.mockResolvedValueOnce([{ userId: "1" }])
    const out = await member("PUT")?.handler?.({
      context: { workspace: { id: "ws-1" } },
      input: { id: "p1", members: [{ userId: "1", inRotation: false }] },
    })
    expect(pipelineService.findOrFail).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      id: "p1",
    })
    expect(pipelineService.findOrFail.mock.calls[0][0]).not.toHaveProperty(
      "viewer",
    )
    expect(pipelineMemberService.set).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      pipelineId: "p1",
      members: [{ userId: "1", inRotation: false }],
    })
    expect(out).toEqual({ data: [{ userId: "1" }] })
  })

  test("PUT on an unknown pipeline propagates the 404 and never writes", async () => {
    pipelineService.findOrFail.mockRejectedValueOnce(
      new Error("Pipeline not found"),
    )
    await expect(
      member("PUT")?.handler?.({
        context: { workspace: { id: "ws-1" } },
        input: { id: "nope", members: [] },
      }),
    ).rejects.toThrow("Pipeline not found")
    expect(pipelineMemberService.set).not.toHaveBeenCalled()
  })
})
