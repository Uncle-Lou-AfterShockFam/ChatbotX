// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { beforeEach, describe, expect, test, vi } from "vitest"

const EXPORTED_CLIENT = /export const \w+ = (\w+)/g
const MEMBERSHIP_ONLY = /workspaceAuthorizedMidddleware/
const USES_FLOWS_GATE = /\.use\(flowsAuthorizedMiddleware/
const USES_MEMBERSHIP_GATE = /\.use\(workspaceAuthorizedMidddleware/

/**
 * s233a: the AI tools (agents, files, functions, MCP servers) sit behind the
 * `(ai)` layout's `flows` permission. The actions and private oRPC routes
 * must apply the same rule, or a member without `flows` writes AI tools (and
 * makes the hub fetch an MCP URL) by calling them directly.
 */
const mocks = vi.hoisted(() => ({
  resolveWorkspaceAccess: vi.fn(),
  findMembership: vi.fn(),
  findOrFail: vi.fn(),
  getAllWorkspaceMembers: vi.fn(),
  checkWorkspaceOwnerAccess: vi.fn().mockResolvedValue(null),
}))

vi.mock("@chatbotx.io/business", () => ({
  isPlatformAdmin: vi.fn().mockResolvedValue(false),
  isSuperAdmin: vi.fn().mockReturnValue(false),
  isWorkspaceScheduledForDeletion: vi.fn().mockReturnValue(false),
  resolveWorkspaceAccess: mocks.resolveWorkspaceAccess,
  workspaceMemberService: { findMembership: mocks.findMembership },
  userQuotaService: {
    getAccessState: vi.fn().mockResolvedValue({ blocked: false }),
  },
  quotaEnforcementService: { isAtLimit: vi.fn().mockResolvedValue(false) },
}))
vi.mock("@chatbotx.io/business/audit", () => ({
  getAuditActor: () => undefined,
  withAuditContext: (_actor: unknown, fn: () => unknown) => fn(),
}))
vi.mock("@chatbotx.io/database/client", () => ({
  findOrFail: mocks.findOrFail,
  isDatabaseError: vi.fn().mockReturnValue(false),
}))
vi.mock("@chatbotx.io/database/schema", () => ({ userModel: {} }))
vi.mock("@/features/workspace-members/queries", () => ({
  getAllWorkspaceMembers: mocks.getAllWorkspaceMembers,
}))
vi.mock("@/lib/auth/utils", () => ({
  getCurrentUserId: vi.fn().mockResolvedValue("user-1"),
}))
vi.mock("@/lib/auth/auth", () => ({ auth: { api: { getSession: vi.fn() } } }))
vi.mock("@/lib/rate-limit/guest-rate-limit", () => ({
  getGuestClientIp: () => "203.0.113.9",
}))
vi.mock("@/lib/workspace/authorize-workspace-access", () => ({
  checkWorkspaceOwnerAccess: mocks.checkWorkspaceOwnerAccess,
  workspaceAccessDenialException: (reason: string) => new Error(reason),
  assertWorkspaceOwnerAccessForMethod: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("@/env", () => ({ isCloud: () => true }))
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "user-agent": "vitest" }),
}))
vi.mock("@/lib/log", () => ({ logger: { error: vi.fn(), warn: vi.fn() } }))
vi.mock("next-intl/server", () => ({
  getTranslations: vi.fn(() => Promise.resolve((key: string) => key)),
}))

const { flowsActionClient, flowsActionClientAllowExpired } = await import(
  "@/lib/safe-action"
)
const { flowsAuthorizedMiddleware } = await import("@/middlewares/auth")
const { workspaceIdrequestParams } = await import("@/features/common/schema")

type ProbeResult = { data?: unknown; serverError?: string }

const probe = (client: typeof flowsActionClient) =>
  client
    .bindArgsSchemas(workspaceIdrequestParams)
    .action(async () => "ran") as unknown as (
    workspaceId: string,
    input: unknown,
  ) => Promise<ProbeResult>

const asMember = (permissions: Record<string, unknown>) => {
  const member = { workspace: { id: "123", ownerId: "owner-1" }, permissions }
  mocks.findMembership.mockResolvedValue(member)
  mocks.resolveWorkspaceAccess.mockResolvedValue({
    workspace: member.workspace,
    member,
    isSupportSession: false,
  })
}

const DENIED = [
  {},
  { contacts: true, broadcast: true, analytics: true, ecommerce: true },
  { flows: false, contacts: true },
  { flows: "true" },
  { superAdmin: "true" },
]
const ALLOWED = [{ flows: true }, { superAdmin: true }]

beforeEach(() => {
  vi.clearAllMocks()
  mocks.findOrFail.mockResolvedValue({
    id: "user-1",
    mustChangePassword: false,
  })
  mocks.getAllWorkspaceMembers.mockResolvedValue({
    workspaceMembers: [],
    workspaces: [],
  })
  mocks.checkWorkspaceOwnerAccess.mockResolvedValue(null)
})

describe("flowsActionClient / flowsActionClientAllowExpired", () => {
  for (const [name, client] of [
    ["flowsActionClient", flowsActionClient],
    ["flowsActionClientAllowExpired", flowsActionClientAllowExpired],
  ] as const) {
    test(`${name}: a member without flows is refused, the handler never runs`, async () => {
      for (const permissions of DENIED) {
        asMember(permissions)
        const result = await probe(client)("123", undefined)
        expect(result.data).toBeUndefined()
        expect(result.serverError).toBe("Flows access required")
      }
    })

    test(`${name}: flows or superAdmin passes`, async () => {
      for (const permissions of ALLOWED) {
        asMember(permissions)
        expect(await probe(client)("123", undefined)).toMatchObject({
          data: "ran",
        })
      }
    })
  }

  test("a non-member is refused before the permission check", async () => {
    mocks.resolveWorkspaceAccess.mockResolvedValue(undefined)
    const result = await probe(flowsActionClient)("123", undefined)
    expect(result.data).toBeUndefined()
    expect(result.serverError).toBeDefined()
  })
})

describe("flowsAuthorizedMiddleware", () => {
  const next = vi.fn(async () => ({ output: "ok" }))
  const call = (method: string) =>
    (
      flowsAuthorizedMiddleware as unknown as (
        opts: unknown,
        workspaceId: string,
      ) => Promise<unknown>
    )(
      {
        context: { user: { id: "user-1" }, headers: new Headers() },
        next,
        procedure: { "~orpc": { route: { method } } },
      },
      "123",
    )

  test("a member without flows gets 403 on reads and writes", async () => {
    for (const permissions of DENIED) {
      asMember(permissions)
      for (const method of ["GET", "POST"]) {
        await expect(call(method)).rejects.toMatchObject({
          code: "FORBIDDEN",
          status: 403,
        })
      }
    }
    expect(next).not.toHaveBeenCalled()
  })

  test("flows or superAdmin passes", async () => {
    for (const permissions of ALLOWED) {
      asMember(permissions)
      await expect(call("POST")).resolves.toMatchObject({ output: "ok" })
    }
  })

  test("a non-member is UNAUTHORIZED", async () => {
    mocks.findMembership.mockResolvedValue(undefined)
    mocks.resolveWorkspaceAccess.mockResolvedValue(undefined)
    await expect(call("GET")).rejects.toMatchObject({ code: "UNAUTHORIZED" })
  })
})

describe("every AI tool action and private route uses the flows gate", () => {
  const FEATURES = join(import.meta.dirname, "..", "src", "features")
  const AI_FEATURES = [
    "ai-agents",
    "ai-files",
    "ai-functions",
    "ai-mcp-servers",
  ]
  const read = (path: string) => readFileSync(path, "utf8")

  test("every exported action is built on a flows client", () => {
    const offenders: string[] = []
    let seen = 0
    for (const feature of AI_FEATURES) {
      const dir = join(FEATURES, feature, "actions")
      for (const file of readdirSync(dir).filter((f) =>
        f.endsWith(".action.ts"),
      )) {
        const source = read(join(dir, file))
        if (!source.startsWith('"use server"')) {
          continue
        }
        for (const match of source.matchAll(EXPORTED_CLIENT)) {
          seen += 1
          if (!match[1]?.startsWith("flowsActionClient")) {
            offenders.push(`${feature}/${file}: ${match[1]}`)
          }
        }
      }
    }
    expect(seen).toBeGreaterThanOrEqual(11)
    expect(offenders).toEqual([])
  })

  test("private routes use flowsAuthorizedMiddleware (agents list excepted)", () => {
    for (const feature of ["ai-files", "ai-functions", "ai-mcp-servers"]) {
      const source = read(join(FEATURES, feature, "api", "private.ts"))
      expect(source).not.toMatch(MEMBERSHIP_ONLY)
      expect(source).toMatch(USES_FLOWS_GATE)
    }
    // The comment-automation forms (membership only) list agents.
    expect(read(join(FEATURES, "ai-agents", "api", "private.ts"))).toMatch(
      USES_MEMBERSHIP_GATE,
    )
  })
})
