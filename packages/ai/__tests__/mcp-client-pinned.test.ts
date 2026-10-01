// @vitest-environment node
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  OutboundFetchNotInstalledError,
  registerOutboundFetch,
  SsrfFetchError,
  uninstallOutboundFetch,
} from "@chatbotx.io/sdk/outbound-fetch"
import { afterEach, describe, expect, test } from "vitest"
import { MCP_RESPONSE_DEADLINE_MS, McpClient } from "../src/server/mcp-client"

/**
 * s233a: the runtime MCP client fetches a member-typed URL from the worker,
 * so every request goes through the pinned outbound fetch registry, never ky
 * or a bare global fetch.
 */
const NO_KY = /from "ky"/
const BARE_FETCH = /(?<![\w.])fetch\(/

type Call = { url: unknown; init: Record<string, unknown>; options: unknown }

const record = (answer: (body: Record<string, unknown>) => unknown) => {
  const calls: Call[] = []
  registerOutboundFetch((url, init, options) => {
    calls.push({ url, init: init as Record<string, unknown>, options })
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    return Promise.resolve(Response.json(answer(body)))
  })
  return calls
}

const ok = (body: Record<string, unknown>, result: unknown) => ({
  jsonrpc: "2.0",
  id: body.id,
  result,
})

const client = () =>
  new McpClient({
    url: "https://mcp.example.com/rpc",
    auth: { type: "token", token: "t0k" },
  })

afterEach(() => uninstallOutboundFetch())

describe("McpClient over the pinned outbound fetch", () => {
  test("every request is a pinned POST, redirects re-checked by the pinned fetch, one overall cap", async () => {
    const results: Record<string, unknown> = {
      "tools/list": { tools: [{ name: "a", inputSchema: {} }] },
      "tools/call": { content: [{ type: "text", text: "hi" }] },
    }
    const calls = record((body) => ok(body, results[String(body.method)] ?? {}))
    const mcp = client()
    expect(await mcp.listTools()).toHaveLength(1)
    await mcp.callTool("a", {})

    const byMethod = new Map(
      calls.map((c) => [JSON.parse(String(c.init.body)).method, c]),
    )
    expect([...byMethod.keys()].sort()).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/call",
      "tools/list",
    ])
    for (const call of calls) {
      expect(call.url).toBe("https://mcp.example.com/rpc")
      expect(call.init).toMatchObject({ method: "POST", redirect: "follow" })
      expect(call.init.signal).toBeInstanceOf(AbortSignal)
      expect(call.init.headers).toMatchObject({ Authorization: "Bearer t0k" })
      expect(call.options).toEqual({ timeoutMs: MCP_RESPONSE_DEADLINE_MS })
    }
  })

  test("a refused address surfaces as a rejected tool call, not a crash", async () => {
    registerOutboundFetch(() =>
      Promise.reject(
        new SsrfFetchError("unsafeAddress", "https://mcp.example.com/rpc"),
      ),
    )
    await expect(client().callTool("a", {})).rejects.toBeInstanceOf(
      SsrfFetchError,
    )
  })

  test("no pinned fetch installed: fails closed", async () => {
    await expect(client().listTools()).rejects.toBeInstanceOf(
      OutboundFetchNotInstalledError,
    )
  })

  test("a JSON-RPC error on a non-2xx answer is still read as the error", async () => {
    registerOutboundFetch((_url, init) => {
      const body = JSON.parse(String(init?.body)) as { id: number }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32_000, message: "boom" },
          }),
          { status: 500 },
        ),
      )
    })
    await expect(client().listTools()).rejects.toThrow("boom")
  })

  test("source gate: no ky and no bare fetch in the MCP client", () => {
    const source = readFileSync(
      join(import.meta.dirname, "..", "src", "server", "mcp-client.ts"),
      "utf8",
    )
    expect(source).not.toMatch(NO_KY)
    expect(source).not.toMatch(BARE_FETCH)
  })
})
