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

const { workspaceTokenAuthAPIForScope, capturedProcedures } = vi.hoisted(() => {
  const capturedProcedures: CapturedProcedure[] = []

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
    workspaceTokenAuthAPIForScope: vi.fn(
      (_scope: string) => workspaceTokenAuthAPI,
    ),
    capturedProcedures,
  }
})

vi.mock("@/orpc", () => ({ workspaceTokenAuthAPIForScope }))

const replyClassificationService = {
  classifyReply: vi.fn(),
  listByContact: vi.fn(),
}
const resolveContactId = vi.fn()

vi.mock("@chatbotx.io/business", () => ({
  contactService: { resolveIdByIdentifier: resolveContactId },
}))
vi.mock("@chatbotx.io/business/reply-classification", () => ({
  replyClassificationService,
}))

await import("@/features/reply-classification/api/public")

const findProcedure = (method: string, path: string) => {
  const found = capturedProcedures.find(
    (p) => p.route.method === method && p.route.path === path,
  )
  if (!found) {
    throw new Error(`No procedure registered for ${method} ${path}`)
  }
  return found
}

const row = {
  id: "rc-1",
  class: "interested",
  source: "manual",
  reason: "said yes",
  sequenceId: "seq-1",
  dealId: "deal-1",
  createdAt: new Date("2026-09-30T10:00:00.000Z"),
}

beforeEach(() => {
  vi.clearAllMocks()
  resolveContactId.mockResolvedValue("contact-1")
})

describe("POST /v1/contacts/{identifier}/reply-classification (s228b)", () => {
  const procedure = findProcedure(
    "POST",
    "/v1/contacts/{identifier}/reply-classification",
  )

  test("classifies the resolved contact's reply as MANUAL and returns the record with ISO dates", async () => {
    replyClassificationService.classifyReply.mockResolvedValueOnce({
      classification: row,
      dealId: "deal-1",
    })
    await expect(
      procedure.handler?.({
        context: { workspace: { id: "workspace-1" } },
        input: {
          identifier: "id:123",
          class: "interested",
          reason: "said yes",
        },
      }),
    ).resolves.toEqual({
      data: { ...row, createdAt: "2026-09-30T10:00:00.000Z" },
    })
    expect(replyClassificationService.classifyReply).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      contactId: "contact-1",
      class: "interested",
      source: "manual",
      reason: "said yes",
    })
  })

  test("a service error (404 contact, 422 class) propagates", async () => {
    const notFound = Object.assign(new Error("nf"), { httpStatusCode: 404 })
    replyClassificationService.classifyReply.mockRejectedValueOnce(notFound)
    await expect(
      procedure.handler?.({
        context: { workspace: { id: "workspace-1" } },
        input: { identifier: "id:123", class: "maybeLater" },
      }),
    ).rejects.toBe(notFound)
  })
})

describe("GET /v1/contacts/{identifier}/reply-classifications (s228b)", () => {
  test("lists the resolved contact's classifications, newest first", async () => {
    const procedure = findProcedure(
      "GET",
      "/v1/contacts/{identifier}/reply-classifications",
    )
    replyClassificationService.listByContact.mockResolvedValueOnce([row])
    await expect(
      procedure.handler?.({
        context: { workspace: { id: "workspace-1" } },
        input: { identifier: "id:123" },
      }),
    ).resolves.toEqual({
      data: [{ ...row, createdAt: "2026-09-30T10:00:00.000Z" }],
    })
    expect(replyClassificationService.listByContact).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      contactId: "contact-1",
    })
  })
})
