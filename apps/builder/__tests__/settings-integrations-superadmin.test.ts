// @vitest-environment node
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { serverActionExports } from "./server-action-exports.test-utils"
import { collectSourceFiles } from "./source-files.test-utils"

const FACTORY_ON_SETTINGS_CLIENT =
  /return settingsActionClientAllowExpired\s*\./
const WORKSPACE_CLIENT = /\bworkspaceActionClient/
const USES_SUPER_ADMIN_GATE = /\.use\(superAdminAuthorizedMiddleware/
const MEMBERSHIP_ONLY = /workspaceAuthorizedMidddleware/
const PERMISSION_SUPER_ADMIN =
  /hasWorkspaceAccess\(\{[^}]*permission: "superAdmin"/

/**
 * s234a (owner decision 2026-10-01): the Settings integrations sit behind the
 * Settings layout's `superAdmin` permission. The actions must apply the same
 * rule, or any member connects, replaces or disconnects an integration (an AI
 * key, Stripe, SMTP, a workspace token) by calling the action directly.
 */
const mocks = vi.hoisted(() => ({
  resolveWorkspaceAccess: vi.fn(),
  findOrFail: vi.fn(),
  getAllWorkspaceMembers: vi.fn(),
  checkWorkspaceOwnerAccess: vi.fn().mockResolvedValue(null),
}))

vi.mock("@chatbotx.io/business", () => ({
  isPlatformAdmin: vi.fn().mockResolvedValue(false),
  isSuperAdmin: vi.fn().mockReturnValue(false),
  isWorkspaceScheduledForDeletion: vi.fn().mockReturnValue(false),
  resolveWorkspaceAccess: mocks.resolveWorkspaceAccess,
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
vi.mock("@/lib/workspace/authorize-workspace-access", () => ({
  checkWorkspaceOwnerAccess: mocks.checkWorkspaceOwnerAccess,
  workspaceAccessDenialException: (reason: string) => new Error(reason),
}))
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "user-agent": "vitest" }),
}))
vi.mock("@/lib/log", () => ({ logger: { error: vi.fn(), warn: vi.fn() } }))
vi.mock("next-intl/server", () => ({
  getTranslations: vi.fn(() => Promise.resolve((key: string) => key)),
}))

const { settingsActionClient, settingsActionClientAllowExpired } = await import(
  "@/lib/safe-action"
)
const { workspaceIdrequestParams } = await import("@/features/common/schema")

type ProbeResult = { data?: unknown; serverError?: string }

const probe = (client: typeof settingsActionClient) =>
  client
    .bindArgsSchemas(workspaceIdrequestParams)
    .action(async () => "ran") as unknown as (
    workspaceId: string,
    input: unknown,
  ) => Promise<ProbeResult>

const asMember = (permissions: Record<string, unknown>) => {
  const member = { workspace: { id: "123", ownerId: "owner-1" }, permissions }
  mocks.resolveWorkspaceAccess.mockResolvedValue({
    workspace: member.workspace,
    member,
    isSupportSession: false,
  })
}

const DENIED = [
  {},
  {
    contacts: true,
    flows: true,
    broadcast: true,
    analytics: true,
    ecommerce: true,
  },
  { superAdmin: false, flows: true },
  { superAdmin: "true" },
  { superAdmin: 1 },
]

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

describe("settingsActionClient / settingsActionClientAllowExpired", () => {
  for (const [name, client] of [
    ["settingsActionClient", settingsActionClient],
    ["settingsActionClientAllowExpired", settingsActionClientAllowExpired],
  ] as const) {
    test(`${name}: a member without superAdmin is refused, the handler never runs`, async () => {
      for (const permissions of DENIED) {
        asMember(permissions)
        const result = await probe(client)("123", undefined)
        expect(result.data, JSON.stringify(permissions)).toBeUndefined()
        expect(result.serverError).toBe("errors.superAdminRequired")
      }
    })

    test(`${name}: superAdmin passes`, async () => {
      asMember({ superAdmin: true })
      expect(await probe(client)("123", undefined)).toMatchObject({
        data: "ran",
      })
    })
  }

  test("a non-member is refused before the permission check", async () => {
    mocks.resolveWorkspaceAccess.mockResolvedValue(undefined)
    const result = await probe(settingsActionClient)("123", undefined)
    expect(result.data).toBeUndefined()
    expect(result.serverError).toBeDefined()
    expect(result.serverError).not.toBe("errors.superAdminRequired")
  })
})

describe("every Settings integration action is built on a superAdmin client", () => {
  const SRC = join(import.meta.dirname, "..", "src")
  const FEATURES = join(SRC, "features")
  const read = (path: string) => readFileSync(path, "utf8")

  // The Settings > Integrations pages, plus SMTP (Settings > Channels).
  const SETTINGS_FEATURES = [
    "integration-active-campaign",
    "integration-claude",
    "integration-deepseek",
    "integration-drip",
    "integration-facebook-ads",
    "integration-gemini",
    "integration-get-response",
    "integration-google-sheets",
    "integration-klaviyo",
    "integration-mailchimp",
    "integration-mailer-lite",
    "integration-moosend",
    "integration-openai",
    "integration-openai-compatible",
    "integration-openrouter",
    "integration-quickbooks",
    "integration-sendgrid",
    "integration-smtp",
    "integration-stripe",
    "integration-woocommerce",
  ]
  const WORKSPACE_TOKEN_ACTIONS = [
    "workspaces/actions/create-workspace-token-action.ts",
    "workspaces/actions/delete-workspace-token-action.ts",
  ]
  // createDisconnectAction is built on settingsActionClientAllowExpired
  // (asserted below).
  const SUPER_ADMIN_ROOTS = new Set([
    "settingsActionClient",
    "settingsActionClientAllowExpired",
    "createDisconnectAction",
  ])

  test("the integration action files", () => {
    const offenders: string[] = []
    let seen = 0
    const paths = [
      ...SETTINGS_FEATURES.flatMap((feature) =>
        collectSourceFiles(join(FEATURES, feature)),
      ),
      ...WORKSPACE_TOKEN_ACTIONS.map((path) => join(FEATURES, path)),
    ]
    for (const path of paths) {
      for (const { name, root } of serverActionExports(path, read(path))) {
        seen += 1
        if (!(root && SUPER_ADMIN_ROOTS.has(root))) {
          offenders.push(`${path.slice(FEATURES.length + 1)} ${name}: ${root}`)
        }
      }
    }
    expect(seen).toBeGreaterThanOrEqual(50)
    expect(offenders).toEqual([])
  })

  // Settings > Channels (and each channel's own pages, all layout-gated on
  // superAdmin). The named exceptions are not Settings writes or gate
  // themselves: calls (contacts / call permission), and the create-or-connect
  // actions that may target a NEW workspace (no workspaceId) and require
  // superAdmin via hasWorkspaceAccess / isSuperAdminMember when one is given.
  const CHANNEL_FEATURES = [
    "integration-api",
    "integration-instagram",
    "integration-messenger",
    "integration-telegram",
    "integration-threads",
    "integration-tiktok",
    "integration-webchat",
    "integration-whatsapp",
    "integration-zalo",
  ]
  const CHANNEL_EXCEPTIONS: Record<string, string> = {
    "integration-api/actions/create-api.action.ts createApiAction":
      "authActionClient",
    "integration-telegram/actions/connect.action.ts connectTelegramAction":
      "authActionClient",
    "integration-webchat/actions/create-webchat.action.ts createWebchatAction":
      "authActionClient",
    "integration-whatsapp/actions/connect.action.ts connectWhatsappAction":
      "authActionClient",
  }
  const CALLING_DIR = "integration-whatsapp/calling/"

  test("the channel action files", () => {
    const offenders: string[] = []
    let seen = 0
    for (const feature of CHANNEL_FEATURES) {
      for (const path of collectSourceFiles(join(FEATURES, feature))) {
        const rel = path.slice(FEATURES.length + 1)
        if (rel.startsWith(CALLING_DIR)) {
          continue
        }
        for (const { name, root } of serverActionExports(path, read(path))) {
          seen += 1
          const allowed = CHANNEL_EXCEPTIONS[`${rel} ${name}`]
          if (!(root && (SUPER_ADMIN_ROOTS.has(root) || root === allowed))) {
            offenders.push(`${rel} ${name}: ${root}`)
          }
        }
      }
    }
    expect(seen).toBeGreaterThanOrEqual(45)
    expect(offenders).toEqual([])
  })

  test("the create-or-connect exceptions require superAdmin for an existing workspace", () => {
    for (const rel of [
      "integration-api/actions/create-api.action.ts",
      "integration-telegram/actions/connect.action.ts",
      "integration-webchat/actions/create-webchat.action.ts",
    ]) {
      expect(read(join(FEATURES, rel)), rel).toMatch(PERMISSION_SUPER_ADMIN)
    }
    for (const rel of [
      "integration-whatsapp/actions/connect-number.ts",
      "channel-connect/lib/resolve-connect-session.ts",
    ]) {
      const source = read(join(FEATURES, rel))
      expect(source, rel).toContain(
        "workspaceMemberService.isSuperAdminMember(",
      )
      expect(source, rel).not.toContain("workspaceMemberService.isMember(")
    }
  })

  test("the disconnect factory is superAdmin-gated and stays open on an expired workspace", () => {
    const source = read(join(SRC, "lib", "integration-actions.ts"))
    expect(source).toMatch(FACTORY_ON_SETTINGS_CLIENT)
    expect(source).not.toMatch(WORKSPACE_CLIENT)
  })

  test("the SMTP list route needs superAdmin", () => {
    const source = read(join(FEATURES, "integration-smtp", "api", "private.ts"))
    expect(source).toMatch(USES_SUPER_ADMIN_GATE)
    expect(source).not.toMatch(MEMBERSHIP_ONLY)
  })
})
