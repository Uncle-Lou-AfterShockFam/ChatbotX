// @vitest-environment node

import { describe, expect, test, vi } from "vitest"

/**
 * s200: every private forms route sits behind the contacts-section gate and
 * scopes on `workspaceId`; the handlers hand the service exactly the fields
 * the wire schema allows (no `force` leak on create, `userId` on create /
 * duplicate).
 */
type Captured = {
  route: { method: string; path: string }
  uses: unknown[]
  handler?: (args: unknown) => unknown
}
const { captured } = vi.hoisted(() => ({ captured: [] as Captured[] }))
vi.mock("@/orpc", () => {
  const make = () => {
    const entry: Captured = { route: { method: "", path: "" }, uses: [] }
    const chain: Record<string, unknown> = {}
    chain.route = (r: Captured["route"]) => {
      entry.route = r
      return chain
    }
    for (const k of ["input", "output", "errors"]) {
      chain[k] = () => chain
    }
    chain.use = (mw: unknown) => {
      entry.uses.push(mw)
      return chain
    }
    chain.handler = (fn: (a: unknown) => unknown) => {
      entry.handler = fn
      captured.push(entry)
      return chain
    }
    return chain
  }
  return {
    authorizedAPI: {
      route: (r: Captured["route"]) =>
        (make().route as (r: unknown) => unknown)(r),
    },
  }
})
const CONTACTS = Symbol("contactsAccessAuthorizedMiddleware")
vi.mock("@/middlewares/auth", () => ({
  workspaceAuthorizedMidddleware: Symbol("workspace"),
  contactsAccessAuthorizedMiddleware: CONTACTS,
}))
const formService = {
  list: vi.fn(async () => []),
  get: vi.fn(async () => ({ id: "f1" })),
  create: vi.fn(async () => ({ id: "f1" })),
  update: vi.fn(async () => ({ id: "f1" })),
  publish: vi.fn(async () => ({ id: "f1" })),
  setStatus: vi.fn(async () => ({ id: "f1" })),
  duplicate: vi.fn(async () => ({ id: "f2" })),
  delete: vi.fn(async () => undefined),
  listSubmissions: vi.fn(async () => ({ data: [], nextCursor: null })),
  deleteSubmission: vi.fn(async () => undefined),
}
vi.mock("@chatbotx.io/business/form", () => ({ formService }))

const { updateFormRequest, createFormRequest, listFormSubmissionsQuery } =
  await import("../src/features/forms/schema/resource")
await import("../src/features/forms/api/private")

const context = { user: { id: "u-1" }, member: { permissions: {} } }
const byPath = (method: string, suffix: string) => {
  const p = captured.find(
    (c) => c.route.method === method && c.route.path.endsWith(suffix),
  )
  if (!p) {
    throw new Error(`no route ${method} ...${suffix}`)
  }
  return p
}

describe("private forms routes (s200)", () => {
  test("ten routes, every one on the contacts-access middleware", () => {
    expect(captured.map((c) => `${c.route.method} ${c.route.path}`)).toEqual([
      "GET /workspaces/{workspaceId}/forms",
      "GET /workspaces/{workspaceId}/forms/{id}",
      "POST /workspaces/{workspaceId}/forms",
      "PUT /workspaces/{workspaceId}/forms/{id}",
      "POST /workspaces/{workspaceId}/forms/{id}/publish",
      "POST /workspaces/{workspaceId}/forms/{id}/status",
      "POST /workspaces/{workspaceId}/forms/{id}/duplicate",
      "DELETE /workspaces/{workspaceId}/forms/{id}",
      "GET /workspaces/{workspaceId}/forms/{id}/submissions",
      "DELETE /workspaces/{workspaceId}/forms/{id}/submissions/{submissionId}",
    ])
    for (const p of captured) {
      expect(p.uses).toEqual([CONTACTS])
    }
  })

  test("create and duplicate pass the caller as userId", async () => {
    await byPath("POST", "/forms").handler?.({
      context,
      input: { workspaceId: "ws-1", title: "Demo", slug: undefined },
    })
    expect(formService.create).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      userId: "u-1",
      data: { title: "Demo", slug: undefined },
    })
    await byPath("POST", "/duplicate").handler?.({
      context,
      input: { workspaceId: "ws-1", id: "f1" },
    })
    expect(formService.duplicate).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      id: "f1",
      userId: "u-1",
    })
  })

  test("update forwards only the write fields plus force", async () => {
    await byPath("PUT", "/forms/{id}").handler?.({
      context,
      input: {
        workspaceId: "ws-1",
        id: "f1",
        title: "T",
        definition: { steps: [] },
        inboxId: null,
        force: true,
      },
    })
    expect(formService.update).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      id: "f1",
      force: true,
      data: {
        title: "T",
        slug: undefined,
        definition: { steps: [] },
        settings: undefined,
        inboxId: null,
      },
    })
  })

  test("submissions list maps id -> formId and the delete names the submission", async () => {
    await byPath("GET", "/submissions").handler?.({
      context,
      input: { workspaceId: "ws-1", id: "f1", cursor: "c", limit: 10 },
    })
    expect(formService.listSubmissions).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      formId: "f1",
      cursor: "c",
      limit: 10,
    })
    await byPath("DELETE", "/{submissionId}").handler?.({
      context,
      input: { workspaceId: "ws-1", id: "f1", submissionId: "s9" },
    })
    expect(formService.deleteSubmission).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      formId: "f1",
      id: "s9",
    })
  })
})

describe("forms wire schemas are closed", () => {
  test("create refuses unknown keys, blank titles and bad slugs", () => {
    expect(createFormRequest.safeParse({ title: "x", bogus: 1 }).success).toBe(
      false,
    )
    expect(createFormRequest.safeParse({ title: "   " }).success).toBe(false)
    expect(
      createFormRequest.safeParse({ title: "x", slug: "Bad" }).success,
    ).toBe(false)
    expect(
      createFormRequest.safeParse({ title: " Demo ", slug: "demo" }).success,
    ).toBe(true)
  })

  test("update refuses unknown keys and a non-int8 inboxId", () => {
    expect(updateFormRequest.safeParse({ status: "published" }).success).toBe(
      false,
    )
    expect(updateFormRequest.safeParse({ inboxId: "abc" }).success).toBe(false)
    expect(
      updateFormRequest.safeParse({ inboxId: null, definition: {} }).success,
    ).toBe(true)
  })

  test("submissions query caps limit and cursor length", () => {
    expect(listFormSubmissionsQuery.safeParse({ limit: 201 }).success).toBe(
      false,
    )
    expect(
      listFormSubmissionsQuery.safeParse({ cursor: "x".repeat(257) }).success,
    ).toBe(false)
    expect(listFormSubmissionsQuery.safeParse({ limit: "50" }).success).toBe(
      true,
    )
  })
})
