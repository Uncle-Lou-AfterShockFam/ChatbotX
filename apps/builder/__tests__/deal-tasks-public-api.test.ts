// @vitest-environment node

import { describe, expect, test, vi } from "vitest"

type RouteConfig = { method: string; path: string; successStatus?: number }
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
vi.mock("@chatbotx.io/business/deal-task", () => ({
  dealTaskService: {},
  dealTaskTemplateService: {},
}))

const { dealTasksPublicRouter, dealTaskTemplatesPublicRouter } = await import(
  "../src/features/deal-tasks/api/public"
)

describe("deal task public API (s192)", () => {
  test("every route is on the deals scope", () => {
    expect(new Set(scopes)).toEqual(new Set(["deals"]))
  })

  test("the routes exist: PATCH for the all-optional task update, PUT for the full template replace, 204 deletes", () => {
    const routes = capturedProcedures.map(
      (p) => `${p.route.method} ${p.route.path}`,
    )
    expect(routes).toEqual([
      "GET /v1/deals/{id}/tasks",
      "POST /v1/deals/{id}/tasks",
      "PATCH /v1/deals/{id}/tasks/{taskId}",
      "POST /v1/deals/{id}/tasks/{taskId}/complete",
      "POST /v1/deals/{id}/tasks/{taskId}/reopen",
      "DELETE /v1/deals/{id}/tasks/{taskId}",
      "POST /v1/deals/{id}/tasks/{taskId}/dependencies",
      "DELETE /v1/deals/{id}/tasks/{taskId}/dependencies/{dependsOnTaskId}",
      "GET /v1/pipelines/{id}/stages/{stageId}/task-templates",
      "POST /v1/pipelines/{id}/stages/{stageId}/task-templates",
      "PUT /v1/pipelines/{id}/stages/{stageId}/task-templates/{templateId}",
      "DELETE /v1/pipelines/{id}/stages/{stageId}/task-templates/{templateId}",
    ])
    for (const p of capturedProcedures) {
      if (p.route.method === "DELETE") {
        expect(p.route.successStatus).toBe(204)
      }
    }
    expect(Object.keys(dealTasksPublicRouter)).toHaveLength(8)
    expect(Object.keys(dealTaskTemplatesPublicRouter)).toHaveLength(4)
  })
})
