// @vitest-environment node

import { beforeEach, describe, expect, test, vi } from "vitest"

const SECRET = "HEADER-SECRET-VALUE-0123456789"
const RAW_TOKEN = "RAW-BEARER-TOKEN-0123456789"
const BOT_FIELD_TOKEN = "{{bot_field:11702000000000001}}"

const headerAuth = {
  type: "header",
  headers: [
    { header: "X-Api-Key", value: SECRET },
    { header: "X-Tenant", value: "tenant-secret-1" },
  ],
}
const row = (auth: unknown) => ({
  id: "21",
  workspaceId: "ws-1",
  name: "mcp",
  url: "https://mcp.example.com",
  auth,
  availableTools: {},
  selectedTools: [],
})

const mocks = vi.hoisted(() => ({
  listAIMcpServers: vi.fn(),
  findBy: vi.fn(),
  update: vi.fn(),
  resolveBotFieldVariableText: vi.fn(),
}))

vi.mock("@chatbotx.io/business", () => ({
  aiMcpServerService: {
    listAIMcpServers: mocks.listAIMcpServers,
    findBy: mocks.findBy,
    update: mocks.update,
  },
}))

vi.mock("@/lib/auth/utils", () => ({
  assertCurrentUserCanAccessChatbot: vi.fn(async () => undefined),
}))

vi.mock("@chatbotx.io/variables", () => ({
  resolveBotFieldVariableText: mocks.resolveBotFieldVariableText,
}))

vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}))

// The safe-action chain reduced to its handler.
vi.mock("@/lib/safe-action", () => {
  const chain = {
    bindArgsSchemas: () => chain,
    inputSchema: () => chain,
    action: (handler: unknown) => handler,
  }
  return { workspaceActionClient: chain }
})

const { toClientAuth, withClientAuth } = await import(
  "../src/features/ai-mcp-servers/lib/client-auth"
)
const { keepsStoredSecret, mergeStoredAuth } = await import(
  "../src/features/ai-mcp-servers/lib/merge-stored-auth"
)
const { resolveValidateAuth } = await import(
  "../src/features/ai-mcp-servers/lib/resolve-validate-auth"
)
const { listAIMcpServers } = await import(
  "../src/features/ai-mcp-servers/queries"
)
const { updateAIMcpServerAction } = await import(
  "../src/features/ai-mcp-servers/actions/update-ai-mcp-server.action"
)
const { updatePrivateAIMcpServerRequest, validatePrivateAIMcpServerRequest } =
  await import("../src/features/ai-mcp-servers/schema/action")

const update = updateAIMcpServerAction as unknown as (props: {
  bindArgsParsedInputs: [string, string]
  parsedInput: unknown
}) => Promise<unknown>

beforeEach(() => {
  vi.clearAllMocks()
})

// s232a: MCP `auth` (raw bearer token, raw custom header values) is
// plaintext jsonb; the MCP table and the private oRPC list sent it whole to
// any workspace member's browser.
describe("MCP server auth never reaches the client", () => {
  test("header values are blanked, header names kept", () => {
    expect(toClientAuth(headerAuth)).toEqual({
      type: "header",
      headers: [
        { header: "X-Api-Key", value: "" },
        { header: "X-Tenant", value: "" },
      ],
    })
  })

  test("a raw token is blanked; a bot-field reference is kept", () => {
    expect(toClientAuth({ type: "token", token: RAW_TOKEN })).toEqual({
      type: "token",
      token: "",
    })
    expect(
      toClientAuth({ type: "token", token: `Bearer-${BOT_FIELD_TOKEN}` }),
    ).toEqual({ type: "token", token: "" })
    expect(toClientAuth({ type: "token", token: BOT_FIELD_TOKEN })).toEqual({
      type: "token",
      token: BOT_FIELD_TOKEN,
    })
  })

  test.each([
    null,
    undefined,
    "string",
    42,
    { type: "header", headers: "x" },
    { type: "other", token: RAW_TOKEN },
  ])("malformed stored auth %j reads as none", (stored) => {
    expect(toClientAuth(stored)).toEqual({ type: "none" })
  })

  test("the list query carries no stored secret", async () => {
    mocks.listAIMcpServers.mockResolvedValue({
      data: [row(headerAuth), row({ type: "token", token: RAW_TOKEN })],
      pageCount: 1,
    })

    const result = await listAIMcpServers({ workspaceId: "ws-1" })

    expect(result.data).toHaveLength(2)
    expect(result.pageCount).toBe(1)
    const body = JSON.stringify(result)
    expect(body).not.toContain(SECRET)
    expect(body).not.toContain("tenant-secret-1")
    expect(body).not.toContain(RAW_TOKEN)
  })

  test("withClientAuth keeps every other column", () => {
    const { auth, ...rest } = withClientAuth(row(headerAuth))
    expect(rest).toEqual({ ...row(null), auth: undefined, ...rest })
    expect(auth.type).toBe("header")
  })
})

describe("an empty value keeps the stored secret", () => {
  test("blank header values are filled by header name", () => {
    const merged = mergeStoredAuth(
      {
        type: "header",
        headers: [
          { header: "X-Tenant", value: "" },
          { header: "X-Api-Key", value: "NEW" },
        ],
      },
      headerAuth,
    )
    expect(merged).toEqual({
      status: "ok",
      auth: {
        type: "header",
        headers: [
          { header: "X-Tenant", value: "tenant-secret-1" },
          { header: "X-Api-Key", value: "NEW" },
        ],
      },
    })
  })

  test("a blank for a header that was never stored is missing", () => {
    expect(
      mergeStoredAuth(
        {
          type: "header",
          headers: [
            { header: "X-Api-Key", value: "" },
            { header: "X-New", value: "" },
          ],
        },
        headerAuth,
      ),
    ).toEqual({ status: "missing", path: "headers.1.value" })
  })

  test("a blank token keeps the stored token, never another type's secret", () => {
    expect(
      mergeStoredAuth(
        { type: "token", token: "" },
        { type: "token", token: RAW_TOKEN },
      ),
    ).toEqual({ status: "ok", auth: { type: "token", token: RAW_TOKEN } })
    expect(mergeStoredAuth({ type: "token", token: "" }, headerAuth)).toEqual({
      status: "missing",
      path: "token",
    })
    expect(
      mergeStoredAuth(
        { type: "header", headers: [{ header: "X-Api-Key", value: "" }] },
        { type: "token", token: RAW_TOKEN },
      ),
    ).toEqual({ status: "missing", path: "headers.0.value" })
  })

  test("nothing stored (or malformed) never yields an empty secret", () => {
    for (const stored of [undefined, null, { type: "header" }]) {
      expect(mergeStoredAuth({ type: "token", token: "" }, stored).status).toBe(
        "missing",
      )
    }
  })

  test("keepsStoredSecret only for a blank token or header value", () => {
    expect(keepsStoredSecret({ type: "none" })).toBe(false)
    expect(keepsStoredSecret({ type: "token", token: BOT_FIELD_TOKEN })).toBe(
      false,
    )
    expect(keepsStoredSecret({ type: "token", token: "" })).toBe(true)
    expect(
      keepsStoredSecret({
        type: "header",
        headers: [{ header: "A", value: "x" }],
      }),
    ).toBe(false)
  })

  test("create still requires every value; update and validate accept blanks", async () => {
    const { createPrivateAIMcpServerRequest } = await import(
      "../src/features/ai-mcp-servers/schema/action"
    )
    const body = {
      name: "mcp",
      url: "https://mcp.example.com",
      availableTools: {},
      selectedTools: [],
      auth: { type: "header", headers: [{ header: "X-Api-Key", value: "" }] },
    }
    expect(createPrivateAIMcpServerRequest.safeParse(body).success).toBe(false)
    expect(updatePrivateAIMcpServerRequest.safeParse(body).success).toBe(true)
    expect(
      validatePrivateAIMcpServerRequest.safeParse({ ...body, id: "21" })
        .success,
    ).toBe(true)
  })
})

describe("updateAIMcpServerAction", () => {
  const input = {
    name: "mcp",
    url: "https://mcp.example.com",
    availableTools: {},
    selectedTools: [],
    auth: { type: "header", headers: [{ header: "X-Api-Key", value: "" }] },
  }

  test("saves the stored header value for a blank", async () => {
    mocks.findBy.mockResolvedValue(row(headerAuth))

    await update({ bindArgsParsedInputs: ["ws-1", "21"], parsedInput: input })

    expect(mocks.findBy).toHaveBeenCalledWith({
      where: { id: "21", workspaceId: "ws-1" },
    })
    expect(mocks.update).toHaveBeenCalledWith(
      { workspaceId: "ws-1", id: "21" },
      {
        ...input,
        auth: {
          type: "header",
          headers: [{ header: "X-Api-Key", value: SECRET }],
        },
      },
    )
  })

  test("a blank with nothing to keep is a validation error, not an empty secret", async () => {
    mocks.findBy.mockResolvedValue(row({ type: "none" }))

    const result = await update({
      bindArgsParsedInputs: ["ws-1", "21"],
      parsedInput: input,
    }).catch((error: unknown) => error)

    expect(mocks.update).not.toHaveBeenCalled()
    expect(result).toBeDefined()
  })

  test("another workspace's server is not found", async () => {
    mocks.findBy.mockResolvedValue(undefined)

    await expect(
      update({ bindArgsParsedInputs: ["ws-2", "21"], parsedInput: input }),
    ).rejects.toThrow()
    expect(mocks.update).not.toHaveBeenCalled()
  })
})

describe("resolveValidateAuth", () => {
  const base = { url: "https://mcp.example.com", workspaceId: "ws-1" }

  test("complete auth is used as given, without a lookup", async () => {
    const auth = {
      type: "header" as const,
      headers: [{ header: "X-Api-Key", value: "typed" }],
    }
    expect(await resolveValidateAuth({ ...base, auth })).toEqual(auth)
    expect(mocks.findBy).not.toHaveBeenCalled()
  })

  test("a blank fills from this workspace's stored server", async () => {
    mocks.findBy.mockResolvedValue(row(headerAuth))

    const auth = await resolveValidateAuth({
      ...base,
      id: "21",
      auth: { type: "header", headers: [{ header: "X-Api-Key", value: "" }] },
    })

    expect(mocks.findBy).toHaveBeenCalledWith({
      where: { id: "21", workspaceId: "ws-1" },
    })
    expect(auth).toEqual({
      type: "header",
      headers: [{ header: "X-Api-Key", value: SECRET }],
    })
  })

  test("a blank without an id, or for a foreign server, is refused", async () => {
    mocks.findBy.mockResolvedValue(undefined)
    const blank = {
      type: "header" as const,
      headers: [{ header: "X-Api-Key", value: "" }],
    }

    await expect(
      resolveValidateAuth({ ...base, auth: blank }),
    ).rejects.toThrow()
    await expect(
      resolveValidateAuth({ ...base, id: "99", auth: blank }),
    ).rejects.toThrow()
    expect(mocks.findBy).toHaveBeenCalledTimes(1)
  })
})
