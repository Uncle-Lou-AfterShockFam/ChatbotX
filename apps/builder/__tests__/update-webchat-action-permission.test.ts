// @vitest-environment node

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { beforeEach, expect, test, vi } from "vitest"

const mockFindByIdForWorkspace = vi.fn()
const mockUpdate = vi.fn()
const mockIsCommunity = vi.fn(() => false)

vi.mock("@/env", () => ({ isCommunity: mockIsCommunity }))

vi.mock("@/features/tenant/utils", () => ({
  getTenantSettings: vi.fn(async () => ({
    appUrl: "https://app.chatbotx.io",
  })),
}))

vi.mock("@/lib/safe-action", () => {
  const chain: Record<string, unknown> = {}
  chain.bindArgsSchemas = () => chain
  chain.inputSchema = () => chain
  chain.action = (fn: unknown) => fn
  return {
    settingsActionClient: chain,
  }
})

vi.mock("@chatbotx.io/business", () => ({
  integrationWebchatService: {
    findByIdForWorkspace: mockFindByIdForWorkspace,
    update: mockUpdate,
  },
}))

vi.mock("@chatbotx.io/business/branding", () => ({
  ensureBrandingMenuEntry: vi.fn((menus: unknown) => menus),
}))

const { updateWebchatAction } = await import(
  "../src/features/integration-webchat/actions/update-webchat.action"
)

const makeInput = (permissions: Record<string, unknown>) => ({
  bindArgsParsedInputs: ["workspace-1", "webchat-1"],
  parsedInput: {
    name: "Support",
    brandColor: "#007bff",
    hideHeader: false,
    showLogo: true,
    hideMessageInput: false,
  },
  ctx: { workspaceMemberPermissions: permissions },
})

beforeEach(() => {
  vi.clearAllMocks()
  mockFindByIdForWorkspace.mockResolvedValue({ id: "webchat-1" })
  mockUpdate.mockResolvedValue(undefined)
})

test("the superAdmin gate is the action client (s234a), not an inline check", () => {
  const source = readFileSync(
    join(
      import.meta.dirname,
      "../src/features/integration-webchat/actions/update-webchat.action.ts",
    ),
    "utf8",
  )
  expect(source).toContain(
    "export const updateWebchatAction = settingsActionClient",
  )
})

test("proceeds to update when the caller is a superAdmin", async () => {
  await (updateWebchatAction as (props: unknown) => Promise<unknown>)(
    makeInput({ superAdmin: true }),
  )

  expect(mockFindByIdForWorkspace).toHaveBeenCalledWith({
    id: "webchat-1",
    workspaceId: "workspace-1",
  })
  expect(mockUpdate).toHaveBeenCalled()
})
