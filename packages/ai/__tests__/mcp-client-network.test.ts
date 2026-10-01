// @vitest-environment node
import http from "node:http"
import type { AddressInfo } from "node:net"
import { pinnedFetch } from "@chatbotx.io/business/net-node"
import {
  registerOutboundFetch,
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
 * s233a: McpClient over the REAL pinned fetch against a local server (loopback
 * allowed for this test only). The method timeout bounds the wait for
 * headers, as ky's did, not a streamed SSE body; a server's /mcp -> /mcp/
 * redirect is followed with the POST body.
 */
vi.mock("../src/constants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/constants")>()
  return {
    ...actual,
    aiTimeouts: {
      ...actual.aiTimeouts,
      httpDefault: 1000,
      mcpList: 1000,
      mcpCall: 1000,
    },
  }
})

const { MCP_MAX_RESPONSE_BYTES, McpClient } = await import(
  "../src/server/mcp-client"
)

let server: http.Server
let other: http.Server
let base = ""
let otherBase = ""
const bodies: string[] = []
const otherHits: { auth?: string; secret?: string }[] = []

const RESULTS: Record<string, unknown> = {
  "tools/list": { tools: [{ name: "slow", inputSchema: {} }] },
  "tools/call": { content: [{ type: "text", text: "done" }] },
}

const answer = (raw: string) => {
  const { id, method } = JSON.parse(raw) as { id?: number; method: string }
  const result = RESULTS[method] ?? {}
  return JSON.stringify({ jsonrpc: "2.0", id, result })
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = ""
    req.on("data", (chunk) => {
      raw += chunk
    })
    req.on("end", () => {
      bodies.push(`${req.url} ${raw}`)
      if (req.url === "/cross-origin") {
        res.writeHead(307, { location: `${otherBase}/mcp` })
        res.end()
        return
      }
      if (req.url === "/huge") {
        res.writeHead(200, { "content-type": "application/json" })
        const chunk = Buffer.alloc(1024 * 1024, 32)
        for (let i = 0; i < 11; i += 1) {
          res.write(chunk)
        }
        res.end(answer(raw))
        return
      }
      if (req.url === "/redirect") {
        res.writeHead(307, { location: "/sse-slow-body" })
        res.end()
        return
      }
      if (req.url === "/slow-headers") {
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" })
          res.end(answer(raw))
        }, 3000)
        return
      }
      // Headers at once, the SSE event after 3x the method timeout (1 s).
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.flushHeaders()
      setTimeout(() => res.end(`data: ${answer(raw)}\n\n`), 3000)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  // A second origin (another port) standing in for the redirect target.
  other = http.createServer((req, res) => {
    let raw = ""
    req.on("data", (chunk) => {
      raw += chunk
    })
    req.on("end", () => {
      otherHits.push({
        auth: req.headers.authorization,
        secret: req.headers["x-mcp-secret"] as string | undefined,
      })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(answer(raw))
    })
  })
  await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve))
  otherBase = `http://127.0.0.1:${(other.address() as AddressInfo).port}`
})

afterAll(async () => {
  for (const s of [server, other]) {
    s.closeAllConnections()
    await new Promise<void>((resolve) => s.close(() => resolve()))
  }
})

afterEach(() => {
  uninstallOutboundFetch()
  bodies.length = 0
  otherHits.length = 0
})

const allowLoopback = () =>
  registerOutboundFetch((input, init, options) =>
    pinnedFetch(input, init, { ...options, isBlocked: () => false }),
  )

type Auth = ConstructorParameters<typeof McpClient>[0]["auth"]
const client = (path: string, auth: Auth = { type: "none" }) =>
  new McpClient({ url: `${base}${path}`, auth })

describe("McpClient over the real pinned fetch", () => {
  test("an SSE body streamed past the method timeout still completes", async () => {
    allowLoopback()
    const result = await client("/sse-slow-body").callTool("slow", {})
    expect(result).toEqual({
      isError: false,
      content: [{ type: "text", text: "done" }],
    })
  })

  test("headers slower than the method timeout still time out", async () => {
    allowLoopback()
    await expect(client("/slow-headers").listTools()).rejects.toMatchObject({
      name: "TimeoutError",
    })
  })

  test("a 307 redirect is followed with the POST body", async () => {
    allowLoopback()
    expect(await client("/redirect").listTools()).toHaveLength(1)
    const redirected = bodies.filter((b) => b.startsWith("/sse-slow-body"))
    expect(redirected.length).toBeGreaterThan(0)
    expect(redirected[0]).toContain('"jsonrpc":"2.0"')
  })

  test("with the real block list, the loopback server is refused before any request", async () => {
    registerOutboundFetch((input, init, options) =>
      pinnedFetch(input, init, options),
    )
    await expect(client("/sse-slow-body").listTools()).rejects.toMatchObject({
      name: "SsrfFetchError",
    })
    expect(bodies).toEqual([])
  })

  test("a header-auth server never follows a redirect: its custom secret header stays home", async () => {
    allowLoopback()
    await expect(
      client("/cross-origin", {
        type: "header",
        headers: [{ header: "x-mcp-secret", value: "s3cret" }],
      }).listTools(),
    ).rejects.toMatchObject({
      name: "SsrfFetchError",
      reason: "unsafeRedirect",
    })
    expect(otherHits).toEqual([])
  })

  test("a token-auth cross-origin redirect is followed without the Authorization header", async () => {
    allowLoopback()
    expect(
      await client("/cross-origin", {
        type: "token",
        token: "t0k",
      }).listTools(),
    ).toHaveLength(1)
    expect(otherHits.length).toBeGreaterThan(0)
    for (const hit of otherHits) {
      expect(hit.auth).toBeUndefined()
    }
  })

  test("a body past the size cap is refused, not buffered", async () => {
    allowLoopback()
    await expect(client("/huge").listTools()).rejects.toThrow(
      `MCP response larger than ${MCP_MAX_RESPONSE_BYTES} bytes`,
    )
  })
})
