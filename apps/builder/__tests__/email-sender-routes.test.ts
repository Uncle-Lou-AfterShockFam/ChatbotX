// @vitest-environment node

import { beforeEach, describe, expect, test, vi } from "vitest"

/**
 * s229b mailbox sender routes: every private route sits behind the
 * workspace-admin gate (superAdmin) and passes the ROUTE's workspaceId to the
 * service; the line's credential feed is scoped to the TOKEN's inbox and
 * workspace, rate-limited, and never cached. No response carries a secret
 * the route did not mean to send.
 */
type Captured = {
  api: "authorized" | "channel"
  route: { method: string; path: string; outputStructure?: string }
  uses: unknown[]
  handler?: (args: unknown) => unknown
}
const { captured } = vi.hoisted(() => ({ captured: [] as Captured[] }))
vi.mock("@/orpc", () => {
  const make = (api: Captured["api"]) => {
    const entry: Captured = { api, route: { method: "", path: "" }, uses: [] }
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
  const api = (kind: Captured["api"]) => ({
    route: (r: Captured["route"]) =>
      (make(kind).route as (r: unknown) => unknown)(r),
  })
  return {
    authorizedAPI: api("authorized"),
    channelApiTokenAPI: api("channel"),
  }
})
const MW = Symbol("superAdminAuthorizedMiddleware")
vi.mock("@/middlewares/auth", () => ({
  superAdminAuthorizedMiddleware: MW,
}))
const rateLimit = vi.fn(async (_args: unknown) => undefined)
vi.mock("@/lib/rate-limit/api-rate-limit", () => ({
  assertApiNotRateLimited: (a: unknown) => rateLimit(a),
}))
vi.mock("@/lib/log", () => ({ logger: { info: vi.fn(), error: vi.fn() } }))
vi.mock("@chatbotx.io/worker-config", () => ({
  enqueueIntegrationJob: vi.fn(),
}))
vi.mock("@chatbotx.io/business", () => ({
  apiChannelOutboxService: {},
  normalizeAck: vi.fn(),
  OUTBOX_MAX_PULL: 50,
}))
const PASSWORD = "feed-pass-123"
const service = {
  listLines: vi.fn(async () => [{ id: "2", name: "line" }]),
  list: vi.fn(async () => []),
  create: vi.fn(async () => ({ id: "s-1" })),
  update: vi.fn(async () => ({ id: "s-1" })),
  setStatus: vi.fn(async () => ({ id: "s-1" })),
  archive: vi.fn(async () => undefined),
  listForLine: vi.fn(async () => [
    { id: "9", auth: { type: "password", password: PASSWORD } },
  ]),
}
vi.mock("@chatbotx.io/business/email-sender", () => ({
  emailSenderService: service,
}))

await import("../src/features/email-senders/api/private")
await import("../src/features/integration-api/api/public")
const byPath = (method: string, path: string) => {
  const entry = captured.find(
    (c) => c.route.method === method && c.route.path === path,
  )
  if (!entry?.handler) {
    throw new Error(`no route ${method} ${path}`)
  }
  return entry
}

beforeEach(() => vi.clearAllMocks())

const base = "/workspaces/{workspaceId}/email-senders"

describe("email sender private routes (s229b)", () => {
  test("all five routes exist and every one is gated to workspace admins", () => {
    const own = captured.filter((c) => c.route.path.startsWith(base))
    expect(own).toHaveLength(5)
    for (const entry of own) {
      expect(entry.api).toBe("authorized")
      expect(entry.uses).toEqual([MW])
    }
  })

  test("each route hands the service the route's workspace (and the caller as creator)", async () => {
    await byPath("GET", base).handler?.({ input: { workspaceId: "1" } })
    expect(service.listLines).toHaveBeenCalledWith({ workspaceId: "1" })
    expect(service.list).toHaveBeenCalledWith({ workspaceId: "1" })
    const body = { workspaceId: "1", lineInboxId: "2", provider: "smtp" }
    await byPath("POST", base).handler?.({
      input: body,
      context: { user: { id: "u-1" } },
    })
    expect(service.create).toHaveBeenCalledWith(body, "u-1")
    await byPath("PATCH", `${base}/{id}`).handler?.({
      input: { workspaceId: "1", id: "5", fromName: "x" },
    })
    expect(service.update).toHaveBeenCalledWith({
      workspaceId: "1",
      id: "5",
      fromName: "x",
    })
    await byPath("POST", `${base}/{id}/status`).handler?.({
      input: { workspaceId: "1", id: "5", status: "paused" },
    })
    expect(service.setStatus).toHaveBeenCalledWith({
      workspaceId: "1",
      id: "5",
      status: "paused",
    })
    await expect(
      byPath("DELETE", `${base}/{id}`).handler?.({
        input: { workspaceId: "1", id: "5" },
      }),
    ).resolves.toEqual({ ok: true })
    expect(service.archive).toHaveBeenCalledWith({ workspaceId: "1", id: "5" })
  })
})

describe("GET /v1/channels/api/senders (s229b credential feed)", () => {
  const feed = () => byPath("GET", "/v1/channels/api/senders")

  test("is a channel-token route with a detailed (header-carrying) output", () => {
    expect(feed().api).toBe("channel")
    expect(feed().route.outputStructure).toBe("detailed")
  })

  test("scoped to the TOKEN's inbox + workspace, rate-limited on that inbox, never cached", async () => {
    const out = (await feed().handler?.({
      input: { lineInboxId: "666", workspaceId: "777" },
      context: { inbox: { id: "2" }, workspace: { id: "1" } },
    })) as { headers: Record<string, string>; body: unknown }
    expect(rateLimit).toHaveBeenCalledWith({
      scope: "channel-api-rate-limit",
      key: "2",
    })
    expect(service.listForLine).toHaveBeenCalledWith({
      workspaceId: "1",
      lineInboxId: "2",
    })
    expect(out.headers).toEqual({ "cache-control": "no-store" })
    expect(out.body).toEqual({
      senders: [{ id: "9", auth: { type: "password", password: PASSWORD } }],
    })
  })

  test("a rate-limited caller gets no feed", async () => {
    rateLimit.mockRejectedValueOnce(new Error("429"))
    await expect(
      feed().handler?.({
        context: { inbox: { id: "2" }, workspace: { id: "1" } },
      }),
    ).rejects.toThrow("429")
    expect(service.listForLine).not.toHaveBeenCalled()
  })
})
