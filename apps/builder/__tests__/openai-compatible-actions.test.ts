import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  findByWorkspaceIdAndId: vi.fn(),
  isDuplicatePreset: vi.fn(() => false),
  returnValidationErrors: vi.fn(
    (_schema: unknown, errors: Record<string, unknown>) => ({
      validationErrors: errors,
    }),
  ),
  update: vi.fn(),
  validateBaseUrl: vi.fn(),
  verifyProvider: vi.fn(),
}))

vi.mock("@/lib/safe-action", () => {
  const chain: Record<string, unknown> = {}
  chain.bindArgsSchemas = () => chain
  chain.inputSchema = () => chain
  chain.action = (fn: unknown) => fn
  return { workspaceActionClient: chain }
})

vi.mock("@/features/common/schema", () => ({
  workspaceIdAndIdRequestParams: [],
  workspaceIdrequestParams: [],
}))

vi.mock("@chatbotx.io/business", () => ({
  integrationOpenaiCompatibleService: {
    connect: mocks.connect,
    findByWorkspaceIdAndId: mocks.findByWorkspaceIdAndId,
    update: mocks.update,
  },
  isOpenaiCompatiblePresetAlreadyConnectedError: mocks.isDuplicatePreset,
  validateOpenaiCompatibleBaseUrlForEnvironment: mocks.validateBaseUrl,
}))

vi.mock("@chatbotx.io/business/errors", () => ({
  ChatbotXException: class ChatbotXException extends Error {
    code = "systemError"
    httpStatusCode = 400

    constructor(message: string, code?: string, httpStatusCode?: number) {
      super(message)
      this.name = "ChatbotXException"
      if (code) {
        this.code = code
      }
      if (httpStatusCode) {
        this.httpStatusCode = httpStatusCode
      }
    }
  },
}))

vi.mock("next-intl/server", () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}))

vi.mock("next-safe-action", () => ({
  returnValidationErrors: mocks.returnValidationErrors,
}))

vi.mock("@/features/integration-openai-compatible/lib", () => ({
  verifyOpenaiCompatibleProvider: mocks.verifyProvider,
}))

const { ChatbotXException } = await import("@chatbotx.io/business/errors")
const { connectOpenaiCompatibleAction } = await import(
  "@/features/integration-openai-compatible/actions/connect.action"
)
const { updateOpenaiCompatibleAction } = await import(
  "@/features/integration-openai-compatible/actions/update.action"
)

type ActionHandler<TParsedInput, TBindArgs extends unknown[]> = (props: {
  parsedInput: TParsedInput
  bindArgsParsedInputs: TBindArgs
}) => Promise<unknown>

const baseInput = {
  apiKey: "secret",
  autoReply: false,
  baseURL: "https://example.com/v1",
  enabled: true,
  name: "Provider",
  preset: "custom",
}

describe("OpenAI-compatible actions", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.validateBaseUrl.mockImplementation(async (baseURL: string) =>
      baseURL.trim(),
    )
    mocks.verifyProvider.mockResolvedValue({ ok: true })
    mocks.findByWorkspaceIdAndId.mockResolvedValue({
      auth: { authType: "secretText", secretText: "existing-key" },
      baseURL: "https://example.com/v1",
    })
  })

  test("connect maps unsafe base URL errors before provider verification", async () => {
    mocks.validateBaseUrl.mockRejectedValue(
      new ChatbotXException("blocked", "ssrfBlocked", 400),
    )

    const result = await (
      connectOpenaiCompatibleAction as unknown as ActionHandler<
        typeof baseInput,
        [string]
      >
    )({
      parsedInput: baseInput,
      bindArgsParsedInputs: ["workspace-1"],
    })

    expect(result).toEqual({
      validationErrors: {
        baseURL: {
          _errors: ["openaiCompatible.validation.invalidBaseURL"],
        },
      },
    })
    expect(mocks.verifyProvider).not.toHaveBeenCalled()
    expect(mocks.connect).not.toHaveBeenCalled()
  })

  test("update validates existing base URL before verifying an API key change", async () => {
    mocks.validateBaseUrl.mockRejectedValue(
      new ChatbotXException("blocked", "ssrfBlocked", 400),
    )

    const result = await (
      updateOpenaiCompatibleAction as unknown as ActionHandler<
        { apiKey: string },
        [string, string]
      >
    )({
      parsedInput: { apiKey: "new-key" },
      bindArgsParsedInputs: ["workspace-1", "integration-1"],
    })

    expect(mocks.findByWorkspaceIdAndId).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      id: "integration-1",
    })
    expect(result).toEqual({
      validationErrors: {
        baseURL: {
          _errors: ["openaiCompatible.validation.invalidBaseURL"],
        },
      },
    })
    expect(mocks.verifyProvider).not.toHaveBeenCalled()
    expect(mocks.update).not.toHaveBeenCalled()
  })

  describe("the stored key is bound to the stored base URL (s233a)", () => {
    const update = (parsedInput: Record<string, unknown>) =>
      (
        updateOpenaiCompatibleAction as unknown as ActionHandler<
          Record<string, unknown>,
          [string, string]
        >
      )({ parsedInput, bindArgsParsedInputs: ["workspace-1", "integration-1"] })

    test("a new base URL without a new key is refused before any request carries the stored key", async () => {
      for (const baseURL of [
        "https://attacker.example/v1",
        "https://example.com/v2",
        "https://example.com.attacker.example/v1",
        "http://example.com/v1",
      ]) {
        const result = await update({ baseURL })
        expect(result, baseURL).toEqual({
          validationErrors: {
            apiKey: {
              _errors: [
                "openaiCompatible.validation.apiKeyRequiredForNewBaseURL",
              ],
            },
          },
        })
      }
      expect(mocks.verifyProvider).not.toHaveBeenCalled()
      expect(mocks.update).not.toHaveBeenCalled()
    })

    test("the same base URL (trailing slash ignored) keeps the stored key", async () => {
      for (const baseURL of [
        "https://example.com/v1",
        "https://example.com/v1/",
      ]) {
        await update({ baseURL, name: "Renamed" })
      }
      expect(mocks.verifyProvider).toHaveBeenCalledTimes(2)
      for (const [args] of mocks.verifyProvider.mock.calls) {
        expect(args).toMatchObject({ apiKey: "existing-key" })
      }
    })

    test("a new base URL with a new key verifies the NEW key, never the stored one", async () => {
      await update({ baseURL: "https://other.example/v1", apiKey: "new-key" })
      expect(mocks.verifyProvider).toHaveBeenCalledWith({
        apiKey: "new-key",
        baseURL: "https://other.example/v1",
      })
    })

    test("a missing stored row never matches (fails closed)", async () => {
      mocks.findByWorkspaceIdAndId.mockResolvedValue(undefined)
      const result = await update({ baseURL: "https://example.com/v1" })
      expect(result).toMatchObject({ validationErrors: { apiKey: {} } })
      expect(mocks.verifyProvider).not.toHaveBeenCalled()
    })
  })
})
