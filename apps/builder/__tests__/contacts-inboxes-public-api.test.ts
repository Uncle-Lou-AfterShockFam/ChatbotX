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
  inputSchema?: { safeParse: (value: unknown) => { success: boolean } }
  errors?: Record<string, { status?: number }>
}

const { workspaceTokenAuthAPIForScope, capturedProcedures } = vi.hoisted(() => {
  const capturedProcedures: CapturedProcedure[] = []

  const makeProcedure = (route: RouteConfig) => {
    const record: CapturedProcedure = { route }
    capturedProcedures.push(record)

    const chain = {
      input: vi.fn((schema: CapturedProcedure["inputSchema"]) => {
        record.inputSchema = schema
        return chain
      }),
      output: vi.fn(() => chain),
      errors: vi.fn((errors: CapturedProcedure["errors"]) => {
        record.errors = errors
        return chain
      }),
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
    workspaceTokenAuthAPIForScope: vi.fn(
      (_scope: string) => workspaceTokenAuthAPI,
    ),
    capturedProcedures,
  }
})

vi.mock("@/orpc", () => ({ workspaceTokenAuthAPIForScope }))

const resolveContactId = vi.fn()

const listContactInboxesForAPI = vi.fn()
const attachContactToInbox = vi.fn()

vi.mock("@chatbotx.io/business", () => ({
  contactService: { resolveIdByIdentifier: resolveContactId },
  contactInboxService: { listByContactIdUncached: listContactInboxesForAPI },
  attachContactToInbox,
}))

await import("@/features/contact-inboxes/api/public")

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
  resolveContactId.mockResolvedValue("contact-1")
})

describe("GET /v1/contacts/{identifier}/inboxes", () => {
  const procedure = findProcedure("GET", "/v1/contacts/{identifier}/inboxes")

  test("resolves the identifier then lists channel identities for that contact", async () => {
    listContactInboxesForAPI.mockResolvedValueOnce([
      { id: "ci-1", channel: "whatsapp", inbox: { name: "Sales" } },
    ])

    await expect(
      procedure.handler?.({
        context: { workspace: { id: "workspace-1" } },
        input: { identifier: "phone:+841234567890" },
      }),
    ).resolves.toEqual({
      data: [{ id: "ci-1", channel: "whatsapp", inbox: { name: "Sales" } }],
    })

    expect(resolveContactId).toHaveBeenCalledWith({
      identifier: "phone:+841234567890",
      workspaceId: "workspace-1",
    })
    expect(listContactInboxesForAPI).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      contactId: "contact-1",
    })
  })
})

describe("POST /v1/contacts/{identifier}/inboxes", () => {
  const procedure = findProcedure("POST", "/v1/contacts/{identifier}/inboxes")
  const attached = {
    id: "ci-2",
    contactId: "contact-1",
    inboxId: "9",
    channel: "api",
    source: "api",
    sourceId: "+12154075123",
  }

  test("resolves the identifier, attaches the contact to the inbox and returns the identity", async () => {
    attachContactToInbox.mockResolvedValueOnce({
      contactInbox: attached,
      inbox: { id: "9", name: "bulktext-gv" },
      conversation: { id: "conv-1" },
      created: true,
    })

    await expect(
      procedure.handler?.({
        context: { workspace: { id: "workspace-1" } },
        input: { identifier: "phone:+12154075123", inboxId: "9" },
      }),
    ).resolves.toEqual({
      data: { ...attached, inbox: { name: "bulktext-gv" } },
      created: true,
    })

    expect(resolveContactId).toHaveBeenCalledWith({
      identifier: "phone:+12154075123",
      workspaceId: "workspace-1",
    })
    expect(attachContactToInbox).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      contactId: "contact-1",
      inboxId: "9",
      sourceId: undefined,
    })
  })

  test("forwards an explicit sourceId and an id: identifier", async () => {
    attachContactToInbox.mockResolvedValueOnce({
      contactInbox: { ...attached, sourceId: "ext-1" },
      inbox: { id: "9", name: "bulktext-gv" },
      conversation: { id: "conv-1" },
      created: false,
    })

    await expect(
      procedure.handler?.({
        context: { workspace: { id: "workspace-1" } },
        input: { identifier: "id:1", inboxId: "9", sourceId: "ext-1" },
      }),
    ).resolves.toMatchObject({ created: false })

    expect(attachContactToInbox).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      contactId: "contact-1",
      inboxId: "9",
      sourceId: "ext-1",
    })
  })

  test("input schema is closed: unknown keys and a non-numeric inboxId are rejected, sourceId is optional", () => {
    const schema = procedure.inputSchema
    expect(schema).toBeDefined()
    expect(
      schema?.safeParse({ identifier: "id:1", inboxId: "9" }).success,
    ).toBe(true)
    expect(
      schema?.safeParse({ identifier: "id:1", inboxId: "9", extra: true })
        .success,
    ).toBe(false)
    expect(
      schema?.safeParse({ identifier: "id:1", inboxId: "gv" }).success,
    ).toBe(false)
    expect(schema?.safeParse({ inboxId: "9" }).success).toBe(false)
    expect(
      schema?.safeParse({ identifier: "id:1", inboxId: "9", sourceId: "" })
        .success,
    ).toBe(false)
  })

  test("declares the 409 owned-by-another-contact error so it reaches the spec", () => {
    expect(procedure.errors?.contactInboxOwnedByAnotherContact?.status).toBe(
      409,
    )
    expect(procedure.errors?.notFound).toBeDefined()
  })
})
