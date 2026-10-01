// @vitest-environment node

import { beforeEach, describe, expect, test, vi } from "vitest"

/**
 * s231b (owner 2026-10-01): a platform-support session never binds a Google
 * mailbox into a customer workspace, and only a REAL workspace admin may mark
 * an API channel as an email line (its token then receives mailbox
 * credentials through the sender feed).
 */
const mocks = vi.hoisted(() => ({
  listLines: vi.fn(),
  list: vi.fn(),
  resolveForOwner: vi.fn(),
  cookieSet: vi.fn(),
  find: vi.fn(),
  updateSettings: vi.fn(),
  record: vi.fn(),
}))

vi.mock("@/lib/safe-action", () => {
  const chain: Record<string, unknown> = {}
  chain.bindArgsSchemas = () => chain
  chain.inputSchema = () => chain
  chain.action = (fn: unknown) => fn
  return { workspaceActionClient: chain }
})
vi.mock("@/features/common/schema", () => ({
  workspaceIdrequestParams: [],
  workspaceIdAndIdRequestParams: [],
}))
vi.mock("@/env", () => ({
  env: { NEXT_PUBLIC_BUILDER_URL: "https://hub.test" },
}))
vi.mock("next/headers", () => ({
  cookies: async () => ({ set: mocks.cookieSet }),
}))
vi.mock("@chatbotx.io/business", () => ({
  platformCredentialService: { resolveForOwner: mocks.resolveForOwner },
  assertPublicUrl: vi.fn(),
}))
vi.mock("@chatbotx.io/business/email-sender", () => ({
  emailSenderService: { listLines: mocks.listLines, list: mocks.list },
  buildGoogleSenderAuthorizeUrl: () => "https://accounts.google.test/auth",
}))
vi.mock("@chatbotx.io/business/audit", () => ({
  auditService: { record: mocks.record },
}))
vi.mock("@/lib/platform-credential-owner", () => ({
  resolvePlatformOwnerId: async () => "owner-1",
}))
vi.mock("@/lib/provider-origin", () => ({
  buildProviderCallbackUrl: async () => "https://hub.test/cb",
}))
vi.mock("@/features/integration-api/queries", () => ({
  findIntegrationApiByWorkspaceAndId: mocks.find,
}))
vi.mock("@chatbotx.io/database/repositories", () => ({
  integrationApiRepository: { updateSettings: mocks.updateSettings },
}))

const { startEmailSenderGoogleConnectAction } = await import(
  "../src/features/email-senders/actions/connect-google.action"
)
const { updateApiAction } = await import(
  "../src/features/integration-api/actions/update-api.action"
)
type Action = (args: unknown) => Promise<unknown>

const admin = { superAdmin: true }
const ctx = (permissions: object, isSupportSession: boolean) => ({
  user: { id: "u-1" },
  workspaceMemberPermissions: permissions,
  isSupportSession,
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listLines.mockResolvedValue([{ id: "2", name: "bulktext-email" }])
  mocks.list.mockResolvedValue([])
  mocks.resolveForOwner.mockResolvedValue({ config: { clientId: "cid" } })
  mocks.find.mockResolvedValue({ id: "7", auth: {}, lineKind: null })
  mocks.updateSettings.mockResolvedValue({})
})

describe("startEmailSenderGoogleConnectAction (s231b)", () => {
  const connect = (isSupportSession: boolean) =>
    (startEmailSenderGoogleConnectAction as unknown as Action)({
      ctx: ctx(admin, isSupportSession),
      bindArgsParsedInputs: ["1"],
      parsedInput: {
        lineInboxId: "2",
        fromName: "Lou",
        firstName: "Lou",
        lastName: "P",
      },
    })

  test("a platform-support session is refused 403 before any state or cookie is minted", async () => {
    await expect(connect(true)).rejects.toMatchObject({
      code: "supportSessionBlocked",
    })
    expect(mocks.cookieSet).not.toHaveBeenCalled()
    expect(mocks.listLines).not.toHaveBeenCalled()
  })

  test("a real admin gets the consent URL", async () => {
    await expect(connect(false)).resolves.toMatchObject({
      url: "https://accounts.google.test/auth",
    })
    expect(mocks.cookieSet).toHaveBeenCalledTimes(1)
  })
})

describe("updateApiAction email line (s231b)", () => {
  const update = (
    permissions: object,
    isSupportSession: boolean,
    parsedInput: object,
  ) =>
    (updateApiAction as unknown as Action)({
      ctx: ctx(permissions, isSupportSession),
      bindArgsParsedInputs: ["1", "7"],
      parsedInput,
    })

  test("marking a channel as an email line: a real admin may, and it is written + audited", async () => {
    await update(admin, false, { emailLine: true })
    expect(mocks.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ lineKind: "email" }),
    )
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.stringContaining("marked as an email line"),
      }),
    )
  })

  test.each([
    ["a platform-support session (synthetic admin)", admin, true],
    ["a member who is not an admin", { contacts: true }, false],
    ["a member with superAdmin as a string", { superAdmin: "true" }, false],
  ])("%s cannot mark or unmark it: 403, nothing written", async (_label, permissions, support) => {
    await expect(
      update(permissions, support, { emailLine: true }),
    ).rejects.toMatchObject({ code: "emailLineSuperAdminRequired" })
    mocks.find.mockResolvedValue({ id: "7", auth: {}, lineKind: "email" })
    await expect(
      update(permissions, support, { emailLine: false }),
    ).rejects.toMatchObject({ code: "emailLineSuperAdminRequired" })
    expect(mocks.updateSettings).not.toHaveBeenCalled()
  })

  test("other settings stay editable by anyone the action allowed before; an unchanged emailLine is not a change", async () => {
    await update({ contacts: true }, true, { name: "renamed" })
    expect(mocks.updateSettings).toHaveBeenCalledWith(
      expect.not.objectContaining({ lineKind: expect.anything() }),
    )
    await update({ contacts: true }, false, {
      name: "renamed",
      emailLine: false,
    })
    expect(mocks.updateSettings).toHaveBeenCalledTimes(2)
  })
})
