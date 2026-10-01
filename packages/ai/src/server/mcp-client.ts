import {
  type AIMcpServerAuth,
  aiMcpServerAuthTypes,
} from "@chatbotx.io/database/partials"
import { outboundFetch } from "@chatbotx.io/sdk/outbound-fetch"
import { normalizeError } from "universal-error-normalizer"
import { aiTimeouts, helpTexts, mcpConstants } from "../constants"
import { logger } from "../logger"
import {
  type JsonObject,
  type JsonValue,
  type MCPTool,
  mcpContentArraySchema,
  mcpJsonRpcErrorResponseSchema,
  mcpJsonRpcSuccessSchema,
} from "../schemas/mcp"

/**
 * Cap on one MCP answer, headers to the end of the (SSE) body. Kept well
 * below the integration worker's 10 min job-lock floor
 * (apps/worker/src/integration/worker.ts), so a slow server can never stall
 * a job into a duplicate run.
 */
export const MCP_RESPONSE_DEADLINE_MS = 3 * 60_000

/** Largest MCP answer read into memory; a longer body is refused. */
export const MCP_MAX_RESPONSE_BYTES = 10 * 1024 * 1024

/** Reads the body as text, refusing past `maxBytes` (a hostile server could stream for minutes). */
const readTextCapped = async (
  response: Response,
  maxBytes: number,
): Promise<string> => {
  if (!response.body) {
    return ""
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let received = 0
  let text = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      return text + decoder.decode()
    }
    received += value.byteLength
    if (received > maxBytes) {
      await reader.cancel()
      throw new Error(`MCP response larger than ${maxBytes} bytes`)
    }
    text += decoder.decode(value, { stream: true })
  }
}

export interface McpClientOptions {
  auth: AIMcpServerAuth
  name?: string
  url: string
}

export const normalizeMcpContent = (content: JsonValue): JsonValue => {
  const parsed = mcpContentArraySchema.safeParse(content)
  if (!parsed.success || parsed.data.length === 0) {
    return content
  }

  const firstItem = parsed.data[0]
  if (
    typeof firstItem === "object" &&
    firstItem !== null &&
    "type" in firstItem &&
    firstItem.type === "text" &&
    "text" in firstItem &&
    typeof firstItem.text === "string"
  ) {
    return firstItem.text
  }

  return content
}

const omitEmptyPagingToken = (args: JsonObject): JsonObject => {
  if (args.paging_token !== "") {
    return args
  }

  const { paging_token: _pagingToken, ...remainingArgs } = args
  return remainingArgs
}

export class McpClient {
  private readonly url: string
  private readonly auth: AIMcpServerAuth
  private readonly name: string
  private initialized = false
  private isLegacy = false
  private requestIdCounter = 0

  constructor(options: McpClientOptions) {
    this.url = options.url
    this.auth = options.auth
    this.name = options.name ?? "MCP Server"
  }

  private getNextRequestId(): number {
    this.requestIdCounter = (this.requestIdCounter + 1) % 1_000_000
    return Date.now() + this.requestIdCounter
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    }

    switch (this.auth.type) {
      case aiMcpServerAuthTypes.enum.header:
        for (const h of this.auth.headers) {
          headers[h.header] = h.value
        }
        break
      case aiMcpServerAuthTypes.enum.token:
        headers.Authorization = `Bearer ${this.auth.token}`
        break
      default:
        break
    }

    return headers
  }

  /**
   * The URL is member-typed: the pinned fetch refuses private / internal
   * addresses at connect and re-checks every redirect hop, dropping
   * credentials across origins (s233a; header-auth servers never follow).
   * `headersTimeoutMs` bounds the wait for
   * the response headers only, as ky's timeout did: a Streamable-HTTP server
   * may open its SSE answer at once and stream a long tool call into it. The
   * body read is capped by MCP_RESPONSE_DEADLINE_MS. Any HTTP status is read
   * as a body (JSON-RPC errors ride on non-2xx answers).
   */
  private async post(body: string, headersTimeoutMs: number) {
    const headersDeadline = new AbortController()
    const timer = setTimeout(
      () =>
        headersDeadline.abort(
          new DOMException("MCP response headers timed out", "TimeoutError"),
        ),
      headersTimeoutMs,
    )
    try {
      return await outboundFetch(
        this.url,
        {
          method: "POST",
          headers: this.getHeaders(),
          body,
          signal: headersDeadline.signal,
          // The pinned fetch drops Authorization across origins, but not a
          // header-auth server's custom secret header: those never follow.
          redirect:
            this.auth.type === aiMcpServerAuthTypes.enum.header
              ? "error"
              : "follow",
        },
        { timeoutMs: MCP_RESPONSE_DEADLINE_MS },
      )
    } finally {
      clearTimeout(timer)
    }
  }

  private async request<T>(
    method: string,
    params: Record<string, unknown> = {},
    timeout?: number,
    isNotification = false,
  ): Promise<T | null> {
    const requestId = isNotification ? undefined : this.getNextRequestId()
    const body = JSON.stringify({
      jsonrpc: helpTexts.jsonRpcVersion,
      ...(requestId === undefined ? {} : { id: requestId }),
      method,
      params,
    })

    try {
      const response = await this.post(body, timeout ?? aiTimeouts.httpDefault)
      const responseText = await readTextCapped(
        response,
        MCP_MAX_RESPONSE_BYTES,
      )
      if (isNotification) {
        return null
      }
      const trimmed = responseText.trim()
      let parsed: unknown

      if (trimmed.includes("data:")) {
        const dataLines = trimmed
          .split("\n")
          .filter((line: string) => line.startsWith("data:"))
          .map((line: string) => line.slice("data:".length).trim())
        const lastData = dataLines.at(-1) ?? "{}"
        parsed = JSON.parse(lastData)
      } else {
        parsed = JSON.parse(trimmed)
      }

      // Check for JSON-RPC error
      const errorParsed = mcpJsonRpcErrorResponseSchema.safeParse(parsed)
      if (errorParsed.success) {
        throw new Error(errorParsed.data.error.message)
      }

      const successParsed = mcpJsonRpcSuccessSchema.safeParse(parsed)
      if (!successParsed.success) {
        throw new Error("Invalid JSON-RPC 2.0 response")
      }

      return successParsed.data.result as T
    } catch (error) {
      const normalized = normalizeError(error)
      logger.error(
        { error: normalized, method, url: this.url },
        `[McpClient][${this.name}] Request failed`,
      )
      throw error
    }
  }

  private async ensureInitialized() {
    if (!this.initialized) {
      await this.initialize()
    }
  }

  async initialize() {
    if (this.initialized) {
      return
    }

    try {
      await this.request(
        mcpConstants.jsonRpcMethods.initialize,
        {
          protocolVersion: mcpConstants.protocolVersion,
          capabilities: {},
          clientInfo: mcpConstants.clientInfo,
        },
        aiTimeouts.mcpList,
      )

      this.request(
        mcpConstants.jsonRpcMethods.notificationsInitialized,
        {},
        undefined,
        true,
      ).catch((err) => {
        logger.warn(
          { error: normalizeError(err) },
          `[McpClient][${this.name}] Failed to send initialized notification`,
        )
      })

      this.initialized = true
      this.isLegacy = false
    } catch (error) {
      const normalized = normalizeError(error)
      const errorMessage = (normalized.message || "").toLowerCase()
      // JSON-RPC -32601 is typically "Method not found"; avoid broad "not found"/"404"
      // so misconfigured URLs or unrelated errors are not treated as legacy MCP.
      if (errorMessage.includes("method not found")) {
        logger.info(
          { url: this.url, name: this.name },
          `[McpClient][${this.name}] Server does not support initialize, switching to legacy mode`,
        )
        this.isLegacy = true
        this.initialized = true
      } else {
        throw error
      }
    }
  }

  async listTools(): Promise<MCPTool[]> {
    await this.ensureInitialized()

    const result = await this.request<{ tools: MCPTool[] }>(
      mcpConstants.jsonRpcMethods.toolsList,
      {},
      aiTimeouts.mcpList,
    )
    return result?.tools ?? []
  }

  async callTool(toolName: string, args: JsonObject) {
    await this.ensureInitialized()

    const result = await this.request<JsonObject>(
      mcpConstants.jsonRpcMethods.toolsCall,
      {
        name: toolName,
        // Initial page requests must omit an optional paging token. Models
        // frequently serialize optional strings as an empty value, so
        // normalize that transport detail before calling any MCP server.
        arguments: omitEmptyPagingToken(args),
      },
      aiTimeouts.mcpCall,
    )

    if (!result) {
      throw new Error(
        `[McpClient][${this.name}] No result returned from tool call: ${toolName}`,
      )
    }

    return {
      // MCP tool errors are returned inside a valid JSON-RPC result, not as a
      // JSON-RPC error response. Preserve that status so callers do not treat
      // a failed tool invocation as an empty successful result.
      isError: result.isError === true,
      content: result.content as JsonValue,
    }
  }

  getLegacyStatus() {
    return this.isLegacy
  }

  async close() {
    await Promise.resolve()
  }
}
