// @vitest-environment node

import { beforeEach, describe, expect, test, vi } from "vitest"

const {
  findWorkspaceByTokenHash,
  isWorkspaceScheduledForDeletion,
  getAccessState,
  isAtLimit,
  assertApiNotRateLimited,
} = vi.hoisted(() => ({
  findWorkspaceByTokenHash: vi.fn(),
  isWorkspaceScheduledForDeletion: vi.fn().mockReturnValue(false),
  getAccessState: vi.fn().mockResolvedValue({ blocked: false }),
  isAtLimit: vi.fn().mockResolvedValue(false),
  assertApiNotRateLimited: vi.fn().mockResolvedValue(undefined),
}))

const dealService = { list: vi.fn(), findOrFail: vi.fn() }
const pipelineService = { list: vi.fn() }

vi.mock("@chatbotx.io/business", () => ({
  workspaceApiTokenService: { findWorkspaceByTokenHash },
  isWorkspaceScheduledForDeletion,
  userQuotaService: { getAccessState },
  quotaEnforcementService: { isAtLimit },
  pipelineService,
}))
vi.mock("@chatbotx.io/business/deal", () => ({ dealService }))
vi.mock("@chatbotx.io/redis", () => ({
  withCache: vi.fn((_key: string, loader: () => unknown) => loader()),
  invalidateCacheByTags: vi.fn(),
}))
vi.mock("@/lib/log", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }))
vi.mock("@/lib/rate-limit/api-rate-limit", () => ({ assertApiNotRateLimited }))
vi.mock("@/lib/rate-limit/guest-rate-limit", () => ({
  getGuestClientIp: () => "203.0.113.9",
}))
vi.mock("@/env", () => ({ isCloud: () => true }))
// `@/orpc` also exports `authorizedAPI` (full better-auth stack); same stub as
// the other *-public-scope tests.
vi.mock("@/middlewares/auth", () => ({ authMiddleware: vi.fn() }))

const { call } = await import("@orpc/server")
const { dealsPublicRouter } = await import("../src/features/deals/api/public")
const { pipelinesPublicRouter } = await import(
  "../src/features/pipelines/api/public"
)

const TOKEN = "cbx_ws_fixture"
const authResult = (scopes: string[] | null) => ({
  workspace: { id: "ws-1", ownerId: "owner-1" },
  apiToken: { id: "token-1", permission: "full" as const, scopes },
})
// Heterogeneous procedures, intentionally untyped.
const invoke = (procedure: any, input: Record<string, unknown> = {}) =>
  call(procedure, input, {
    context: { headers: new Headers({ Authorization: `Bearer ${TOKEN}` }) },
  })

beforeEach(() => {
  vi.clearAllMocks()
  isWorkspaceScheduledForDeletion.mockReturnValue(false)
  getAccessState.mockResolvedValue({ blocked: false })
  isAtLimit.mockResolvedValue(false)
  assertApiNotRateLimited.mockResolvedValue(undefined)
})

describe("real router: deals + pipelines public API scope wiring (s192)", () => {
  test("a contacts-scoped token is denied GET /v1/deals with FORBIDDEN", async () => {
    findWorkspaceByTokenHash.mockResolvedValue(authResult(["contacts"]))
    await expect(invoke(dealsPublicRouter.list)).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Token is not authorized for the 'deals' scope",
    })
    expect(dealService.list).not.toHaveBeenCalled()
  })

  test("a contacts-scoped token is denied GET /v1/pipelines with FORBIDDEN", async () => {
    findWorkspaceByTokenHash.mockResolvedValue(authResult(["contacts"]))
    await expect(invoke(pipelinesPublicRouter.list)).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Token is not authorized for the 'deals' scope",
    })
    expect(pipelineService.list).not.toHaveBeenCalled()
  })

  test("a deals-scoped token passes GET /v1/pipelines", async () => {
    findWorkspaceByTokenHash.mockResolvedValue(authResult(["deals"]))
    pipelineService.list.mockResolvedValue([])
    await expect(invoke(pipelinesPublicRouter.list)).resolves.toMatchObject({
      data: [],
    })
  })

  test("null scopes (unrestricted) passes GET /v1/pipelines", async () => {
    findWorkspaceByTokenHash.mockResolvedValue(authResult(null))
    pipelineService.list.mockResolvedValue([])
    await expect(invoke(pipelinesPublicRouter.list)).resolves.toMatchObject({
      data: [],
    })
  })

  test("an empty scope list (no scopes at all) is denied", async () => {
    findWorkspaceByTokenHash.mockResolvedValue(authResult([]))
    await expect(invoke(dealsPublicRouter.list)).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
  })
})
