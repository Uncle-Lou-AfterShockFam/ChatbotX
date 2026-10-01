// @vitest-environment node

import { beforeEach, describe, expect, test, vi } from "vitest"

const SECRET = "sk-PROVIDER-API-KEY-SECRET"
const row = (auth: unknown = { secretText: SECRET }) => ({
  id: "11",
  workspaceId: "ws-1",
  autoReply: true,
  model: "some-model",
  auth,
})

const findByWorkspaceId = vi.fn()
const update = vi.fn()
const service = { findByWorkspaceId, update }

vi.mock("@chatbotx.io/business", () => ({
  integrationOpenAIService: service,
  integrationGeminiService: service,
  integrationClaudeService: service,
  integrationDeepSeekService: service,
  integrationOpenRouterService: service,
}))

vi.mock("@chatbotx.io/ai/server", () => ({
  aiIntegrationService: { invalidateCache: vi.fn() },
}))

// The safe-action chain reduced to its handler, so the test sees exactly what
// the action returns to the browser.
vi.mock("@/lib/safe-action", () => {
  const chain = {
    bindArgsSchemas: () => chain,
    inputSchema: () => chain,
    action: (handler: unknown) => handler,
  }
  return { settingsActionClient: chain }
})

const { toAiIntegrationSummary } = await import(
  "../src/lib/ai-integration-summary"
)
const { findIntegrationOpenAI } = await import(
  "../src/features/integration-openai/queries"
)
const { findIntegrationGemini } = await import(
  "../src/features/integration-gemini/queries"
)
const { findIntegrationClaude } = await import(
  "../src/features/integration-claude/queries"
)
const { findIntegrationDeepSeek } = await import(
  "../src/features/integration-deepseek/queries"
)
const { findIntegrationOpenRouter } = await import(
  "../src/features/integration-openrouter/queries"
)
const { updateIntegrationOpenAIAction } = await import(
  "../src/features/integration-openai/actions/update-openai.action"
)

beforeEach(() => {
  vi.clearAllMocks()
})

// s232a: an AI-provider row's `auth` is the plaintext API key, and the
// settings pages hand their query result to a "use client" component.
describe("AI-provider API keys never reach a client component", () => {
  test("the summary keeps id, autoReply and whether a key is stored", () => {
    const summary = toAiIntegrationSummary(row())

    expect(summary).toEqual({ id: "11", autoReply: true, isConnected: true })
    expect(JSON.stringify(summary)).not.toContain(SECRET)
  })

  test("a row without auth is not connected; a missing row is null", () => {
    expect(toAiIntegrationSummary(row(null))?.isConnected).toBe(false)
    expect(
      toAiIntegrationSummary({ ...row(), auth: undefined })?.isConnected,
    ).toBe(false)
    expect(toAiIntegrationSummary(null)).toBeNull()
    expect(toAiIntegrationSummary(undefined)).toBeNull()
  })

  test.each([
    ["Gemini", findIntegrationGemini],
    ["Claude", findIntegrationClaude],
    ["DeepSeek", findIntegrationDeepSeek],
    ["OpenRouter", findIntegrationOpenRouter],
  ])("the %s settings query returns the summary only", async (_, find) => {
    findByWorkspaceId.mockResolvedValue(row())

    const result = await find({ workspaceId: "ws-1" })

    expect(findByWorkspaceId).toHaveBeenCalledWith("ws-1")
    expect(result).toEqual({ id: "11", autoReply: true, isConnected: true })
    expect(JSON.stringify(result)).not.toContain(SECRET)
  })

  test("the OpenAI settings query returns the summary only", async () => {
    findByWorkspaceId.mockResolvedValue(row())

    const result = await findIntegrationOpenAI({ workspaceId: "ws-1" })

    expect(result).toEqual({
      data: { id: "11", autoReply: true, isConnected: true },
    })
    expect(JSON.stringify(result)).not.toContain(SECRET)
  })

  test("a workspace with no integration yields null", async () => {
    findByWorkspaceId.mockResolvedValue(undefined)

    expect(await findIntegrationClaude({ workspaceId: "ws-1" })).toBeNull()
    expect(await findIntegrationOpenAI({ workspaceId: "ws-1" })).toEqual({
      data: null,
    })
  })

  test("the OpenAI auto-reply action returns autoReply, never the row", async () => {
    update.mockResolvedValue({ ...row(), autoReply: false })
    const handler = updateIntegrationOpenAIAction as unknown as (props: {
      bindArgsParsedInputs: [string, string]
      parsedInput: { autoReply: boolean }
    }) => Promise<unknown>

    const result = await handler({
      bindArgsParsedInputs: ["ws-1", "11"],
      parsedInput: { autoReply: false },
    })

    expect(update).toHaveBeenCalledWith(
      { workspaceId: "ws-1", id: "11" },
      { autoReply: false },
    )
    expect(result).toEqual({ autoReply: false })
  })
})
