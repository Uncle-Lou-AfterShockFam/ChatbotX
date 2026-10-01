// @vitest-environment node
import http from "node:http"
import type { AddressInfo } from "node:net"
import {
  registerOutboundFetch,
  SsrfFetchError,
  uninstallOutboundFetch,
} from "@chatbotx.io/sdk/outbound-fetch"
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from "vitest"

/**
 * s233a: MCP validate makes the hub fetch a member-typed URL. It must go
 * through the connection-pinned outbound fetch, so a private / loopback /
 * metadata address is refused before any connection, with one generic
 * answer that never names the check.
 */
vi.mock("@chatbotx.io/variables/bot-field-variable-resolver", () => ({
  resolveBotFieldVariableText: vi.fn(),
}))

const { installPinnedOutboundFetch } = await import(
  "@chatbotx.io/business/net-node"
)
const { validateAIMcpServer } = await import(
  "@/features/ai-mcp-servers/actions/validate-ai-mcp-server.action"
)
const { isSsrfRefusal, pinnedMcpFetch } = await import(
  "@/features/ai-mcp-servers/lib/pinned-mcp-fetch"
)

let server: http.Server
let port = 0
let hits = 0

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    hits += 1
    res.writeHead(200, { "content-type": "application/json" })
    res.end("{}")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

afterEach(() => {
  uninstallOutboundFetch()
  hits = 0
})

const validate = (url: string) =>
  validateAIMcpServer({
    parsedInput: {
      url,
      auth: { type: "header", headers: [{ header: "x-key", value: "secret" }] },
      workspaceId: "1",
    } as Parameters<typeof validateAIMcpServer>[0]["parsedInput"],
  })

describe("validateAIMcpServer through the pinned fetch", () => {
  test("loopback, localhost, IPv6 loopback, metadata and unspecified addresses are refused before any connection", async () => {
    installPinnedOutboundFetch()
    for (const url of [
      `http://127.0.0.1:${port}/mcp`,
      `http://localhost:${port}/mcp`,
      `http://[::1]:${port}/mcp`,
      `http://[::ffff:127.0.0.1]:${port}/mcp`,
      "http://169.254.169.254/latest/meta-data/",
      `http://0.0.0.0:${port}/mcp`,
      "http://10.0.0.1/mcp",
    ]) {
      await expect(validate(url), url).rejects.toMatchObject({
        message: "Unable to validate MCP server.",
        code: "mcpServerUrlRefused",
        httpStatusCode: 400,
      })
    }
    expect(hits).toBe(0)
  })

  test("with no pinned fetch installed, validate fails closed (never an unpinned fetch)", async () => {
    await expect(validate(`http://127.0.0.1:${port}/mcp`)).rejects.toThrow()
    expect(hits).toBe(0)
  })
})

describe("pinnedMcpFetch", () => {
  test("forwards a string URL + string body with redirects refused, whatever the caller asked", async () => {
    const calls: unknown[][] = []
    registerOutboundFetch((...args) => {
      calls.push(args)
      return Promise.resolve(new Response("{}"))
    })
    await pinnedMcpFetch("https://mcp.example.com/x", {
      method: "POST",
      headers: { a: "1" },
      body: "{}",
      redirect: "follow",
    })
    await pinnedMcpFetch(new URL("https://mcp.example.com/y"), {
      method: "DELETE",
    })
    expect(calls).toHaveLength(2)
    expect(calls[0]?.[0]).toBe("https://mcp.example.com/x")
    expect(calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: { a: "1" },
      body: "{}",
      redirect: "error",
    })
    expect(calls[1]?.[1]).toMatchObject({ method: "DELETE", redirect: "error" })
  })

  test("refuses a Request object or a non-string body instead of sending it unpinned", async () => {
    const outbound = vi.fn(() => Promise.resolve(new Response("{}")))
    registerOutboundFetch(outbound)
    await expect(
      pinnedMcpFetch(new Request("https://mcp.example.com/") as never),
    ).rejects.toThrow(TypeError)
    await expect(
      pinnedMcpFetch("https://mcp.example.com/", {
        method: "POST",
        body: new Uint8Array([1]),
      }),
    ).rejects.toThrow(TypeError)
    expect(outbound).not.toHaveBeenCalled()
  })
})

describe("isSsrfRefusal", () => {
  const refusal = new SsrfFetchError("unsafeAddress", "http://10.0.0.1/")

  test("finds the refusal directly or a few causes down", () => {
    expect(isSsrfRefusal(refusal)).toBe(true)
    expect(isSsrfRefusal(new Error("wrapped", { cause: refusal }))).toBe(true)
    expect(
      isSsrfRefusal(
        new Error("a", { cause: new Error("b", { cause: refusal }) }),
      ),
    ).toBe(true)
  })

  test("other errors, null, primitives and a cause cycle are not refusals", () => {
    const cyclic = new Error("cycle") as Error & { cause?: unknown }
    cyclic.cause = cyclic
    for (const value of [new Error("x"), null, undefined, "x", 1, cyclic]) {
      expect(isSsrfRefusal(value)).toBe(false)
    }
  })
})
