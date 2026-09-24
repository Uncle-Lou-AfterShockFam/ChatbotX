import { beforeEach, describe, expect, test, vi } from "vitest"

type RouteConfig = {
  method: string
  path: string
  summary: string
  tags: string[]
  successStatus?: number
}

type CapturedProcedure = {
  route: RouteConfig
  handler?: (...args: any[]) => any
}

const { workspaceTokenAuthAPIForScope, capturedProcedures, scopes } =
  vi.hoisted(() => {
    const capturedProcedures: CapturedProcedure[] = []
    const scopes: string[] = []
    const makeProcedure = (route: RouteConfig) => {
      const record: CapturedProcedure = { route }
      capturedProcedures.push(record)
      const chain = {
        input: vi.fn(() => chain),
        output: vi.fn(() => chain),
        errors: vi.fn(() => chain),
        handler: vi.fn((fn: (...args: any[]) => any) => {
          record.handler = fn
          return { handler: fn }
        }),
      }
      return chain
    }
    const workspaceTokenAuthAPI = {
      route: vi.fn((config: RouteConfig) => makeProcedure(config)),
    }
    return {
      workspaceTokenAuthAPIForScope: vi.fn((scope: string) => {
        scopes.push(scope)
        return workspaceTokenAuthAPI
      }),
      capturedProcedures,
      scopes,
    }
  })

vi.mock("@/orpc", () => ({ workspaceTokenAuthAPIForScope }))

const dealService = {
  list: vi.fn(),
  findOrFail: vi.fn(),
  listActivities: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  moveStage: vi.fn(),
  setStatus: vi.fn(),
  addNote: vi.fn(),
  remove: vi.fn(),
  listByContactId: vi.fn(),
}
const pipelineService = {
  list: vi.fn(),
  find: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  upsertStage: vi.fn(),
  reorderStages: vi.fn(),
  removeStage: vi.fn(),
}
const resolveIdByIdentifier = vi.fn()

vi.mock("@chatbotx.io/business", () => ({
  pipelineService,
  contactService: { resolveIdByIdentifier },
}))
vi.mock("@chatbotx.io/business/deal", () => ({ dealService }))

await import("@/features/deals/api/public")
await import("@/features/pipelines/api/public")
await import("@/features/contacts/api/public/deals")

const context = { workspace: { id: "ws-1" } }

const findProcedure = (method: string, path: string) => {
  const found = capturedProcedures.find(
    (p) => p.route.method === method && p.route.path === path,
  )
  if (!found) {
    throw new Error(`No procedure registered for ${method} ${path}`)
  }
  return found
}

beforeEach(() => {
  vi.clearAllMocks()
  resolveIdByIdentifier.mockResolvedValue("contact-1")
})

describe("deals + pipelines public API", () => {
  test("every route is on the contacts scope", () => {
    expect(new Set(scopes)).toEqual(new Set(["contacts"]))
  })

  test("the expected routes exist with PATCH for the all-optional updates", () => {
    const routes = capturedProcedures.map(
      (p) => `${p.route.method} ${p.route.path}`,
    )
    expect(routes).toEqual(
      expect.arrayContaining([
        "GET /v1/deals",
        "GET /v1/deals/{id}",
        "GET /v1/deals/{id}/activities",
        "POST /v1/deals",
        "PATCH /v1/deals/{id}",
        "POST /v1/deals/{id}/move",
        "POST /v1/deals/{id}/status",
        "POST /v1/deals/{id}/notes",
        "DELETE /v1/deals/{id}",
        "GET /v1/pipelines",
        "GET /v1/pipelines/{id}",
        "POST /v1/pipelines",
        "PATCH /v1/pipelines/{id}",
        "DELETE /v1/pipelines/{id}",
        "PUT /v1/pipelines/{id}/stages",
        "PUT /v1/pipelines/{id}/stages/order",
        "DELETE /v1/pipelines/{id}/stages/{stageId}",
        "GET /v1/contacts/{identifier}/deals",
      ]),
    )
  })

  test("every write is scoped to the token's workspace, never an input workspaceId", async () => {
    dealService.create.mockResolvedValueOnce({ id: "d1" })
    await findProcedure("POST", "/v1/deals").handler?.({
      context,
      input: { pipelineId: "p1", title: "Roof", workspaceId: "ws-EVIL" },
    })
    expect(dealService.create).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      data: { pipelineId: "p1", title: "Roof", workspaceId: "ws-EVIL" },
    })
    // the service reads `workspaceId` from the outer prop only
    expect(dealService.create.mock.calls[0][0].workspaceId).toBe("ws-1")
  })

  test("DELETE /v1/deals/{id}: a foreign or unknown id is a 404, not a 204", async () => {
    dealService.remove.mockResolvedValueOnce({ deletedCount: 0 })
    await expect(
      findProcedure("DELETE", "/v1/deals/{id}").handler?.({
        context,
        input: { id: "9" },
      }),
    ).rejects.toMatchObject({ code: "notFound" })
    expect(dealService.remove).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      ids: ["9"],
    })
  })

  test("POST /v1/deals/{id}/move passes stage + position through", async () => {
    dealService.moveStage.mockResolvedValueOnce({ id: "d1" })
    await findProcedure("POST", "/v1/deals/{id}/move").handler?.({
      context,
      input: { id: "d1", stageId: "s2", position: 1500 },
    })
    expect(dealService.moveStage).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      id: "d1",
      stageId: "s2",
      position: 1500,
    })
  })

  test("POST /v1/deals/{id}/status forwards the status", async () => {
    dealService.setStatus.mockResolvedValueOnce({ id: "d1", status: "won" })
    await expect(
      findProcedure("POST", "/v1/deals/{id}/status").handler?.({
        context,
        input: { id: "d1", status: "won" },
      }),
    ).resolves.toMatchObject({ status: "won" })
    expect(dealService.setStatus).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      id: "d1",
      status: "won",
    })
  })

  test("GET /v1/contacts/{identifier}/deals resolves the identifier then lists", async () => {
    dealService.listByContactId.mockResolvedValueOnce([{ id: "d1" }])
    await expect(
      findProcedure("GET", "/v1/contacts/{identifier}/deals").handler?.({
        context,
        input: { identifier: "phone:+15550001234" },
      }),
    ).resolves.toEqual({ data: [{ id: "d1" }] })
    expect(resolveIdByIdentifier).toHaveBeenCalledWith({
      identifier: "phone:+15550001234",
      workspaceId: "ws-1",
    })
  })

  test("DELETE /v1/pipelines/{id}/stages/{stageId} forwards moveDealsTo", async () => {
    pipelineService.removeStage.mockResolvedValueOnce({ movedDeals: 2 })
    await expect(
      findProcedure("DELETE", "/v1/pipelines/{id}/stages/{stageId}").handler?.({
        context,
        input: { id: "p1", stageId: "s1", moveDealsTo: "s2" },
      }),
    ).resolves.toEqual({ movedDeals: 2 })
    expect(pipelineService.removeStage).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      pipelineId: "p1",
      stageId: "s1",
      moveDealsTo: "s2",
    })
  })

  test("a service rejection propagates unchanged (foreign stage 422 stays 422)", async () => {
    dealService.moveStage.mockRejectedValueOnce(
      Object.assign(new Error("Stage is not in this pipeline."), {
        code: "validation",
      }),
    )
    await expect(
      findProcedure("POST", "/v1/deals/{id}/move").handler?.({
        context,
        input: { id: "d1", stageId: "foreign" },
      }),
    ).rejects.toMatchObject({ code: "validation" })
  })
})
