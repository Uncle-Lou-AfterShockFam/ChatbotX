// @vitest-environment node

import { describe, expect, test, vi } from "vitest"

/** The s193 deal comment routes: all on the deals scope, list/create/edit (PUT: the body is required)/delete, 204 on delete. */
type RouteConfig = {
  method: string
  path: string
  description?: string
  successStatus?: number
}
const { capturedProcedures, scopes, workspaceTokenAuthAPIForScope } =
  vi.hoisted(() => {
    const capturedProcedures: { route: RouteConfig }[] = []
    const scopes: string[] = []
    const makeProcedure = (route: RouteConfig) => {
      const chain: Record<string, unknown> = { route }
      for (const k of ["input", "output", "errors", "handler"]) {
        chain[k] = () => chain
      }
      capturedProcedures.push(chain as { route: RouteConfig })
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
vi.mock("@/orpc", () => ({ workspaceTokenAuthAPIForScope }))
vi.mock("@chatbotx.io/business/deal-comment", () => ({
  dealCommentService: {},
}))

const { dealCommentsPublicRouter } = await import(
  "../src/features/deal-comments/api/public"
)

describe("deal comments public API (s193)", () => {
  test("every route is on the deals scope, with a >= 50-char description", () => {
    expect(new Set(scopes)).toEqual(new Set(["deals"]))
    for (const p of capturedProcedures) {
      expect(p.route.description?.length ?? 0).toBeGreaterThanOrEqual(50)
    }
  })

  test("the four routes exist; POST is 201 and DELETE is 204", () => {
    expect(
      capturedProcedures.map((p) => `${p.route.method} ${p.route.path}`),
    ).toEqual([
      "GET /v1/deals/{id}/comments",
      "POST /v1/deals/{id}/comments",
      "PUT /v1/deals/{id}/comments/{commentId}",
      "DELETE /v1/deals/{id}/comments/{commentId}",
    ])
    expect(capturedProcedures[1].route.successStatus).toBe(201)
    expect(capturedProcedures[3].route.successStatus).toBe(204)
    expect(Object.keys(dealCommentsPublicRouter)).toHaveLength(4)
  })
})
