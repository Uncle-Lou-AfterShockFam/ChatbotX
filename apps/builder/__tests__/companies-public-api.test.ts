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

const companyService = {
  list: vi.fn(),
  findOrFail: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  assignContact: vi.fn(),
}
const resolveIdByIdentifier = vi.fn()
const stopCompany = vi.fn()

vi.mock("@chatbotx.io/business", () => ({
  companyService,
  contactService: { resolveIdByIdentifier },
}))
vi.mock("@chatbotx.io/business/company-stop", () => ({ stopCompany }))

await import("@/features/companies/api/public")
await import("@/features/contacts/api/public/company")

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

describe("companies public API", () => {
  test("every route is on the contacts scope", () => {
    expect(new Set(scopes)).toEqual(new Set(["contacts"]))
  })

  test("DELETE /v1/companies/{id}: a foreign or unknown id is a 404, not a 204", async () => {
    companyService.delete.mockResolvedValueOnce({ deletedCount: 0 })
    const procedure = findProcedure("DELETE", "/v1/companies/{id}")
    await expect(
      procedure.handler?.({ context, input: { id: "9" } }),
    ).rejects.toMatchObject({ code: "notFound" })
    expect(companyService.delete).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      ids: ["9"],
    })
  })

  test("POST /v1/companies/{id}/stop: checks ownership, then stops with reason api and returns the result body", async () => {
    companyService.findOrFail.mockResolvedValueOnce({ id: "5" })
    stopCompany.mockResolvedValueOnce({
      status: "already_stopped",
      companyId: "5",
    })
    const procedure = findProcedure("POST", "/v1/companies/{id}/stop")
    await expect(
      procedure.handler?.({ context, input: { id: "5", force: false } }),
    ).resolves.toEqual({ status: "already_stopped", companyId: "5" })
    expect(companyService.findOrFail).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      id: "5",
    })
    expect(stopCompany).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      companyId: "5",
      reason: "api",
      force: false,
    })
  })

  test("POST /v1/companies/{id}/stop: a foreign id never reaches stopCompany", async () => {
    companyService.findOrFail.mockRejectedValueOnce(
      Object.assign(new Error("nf"), { code: "notFound" }),
    )
    const procedure = findProcedure("POST", "/v1/companies/{id}/stop")
    await expect(
      procedure.handler?.({ context, input: { id: "5" } }),
    ).rejects.toMatchObject({ code: "notFound" })
    expect(stopCompany).not.toHaveBeenCalled()
  })

  test("PUT /v1/contacts/{identifier}/company resolves the identifier then assigns", async () => {
    const procedure = findProcedure("PUT", "/v1/contacts/{identifier}/company")
    await procedure.handler?.({
      context,
      input: { identifier: "email:lou@acme.com", companyId: "5" },
    })
    expect(resolveIdByIdentifier).toHaveBeenCalledWith({
      identifier: "email:lou@acme.com",
      workspaceId: "ws-1",
    })
    expect(companyService.assignContact).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      contactId: "contact-1",
      companyId: "5",
    })
  })

  test("DELETE /v1/contacts/{identifier}/company clears the link", async () => {
    const procedure = findProcedure(
      "DELETE",
      "/v1/contacts/{identifier}/company",
    )
    await procedure.handler?.({ context, input: { identifier: "42" } })
    expect(companyService.assignContact).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      contactId: "contact-1",
      companyId: null,
    })
  })
})
