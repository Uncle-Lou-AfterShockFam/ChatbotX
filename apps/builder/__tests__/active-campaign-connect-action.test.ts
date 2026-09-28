import { beforeEach, describe, expect, test, vi } from "vitest"

// s219: a refused ActiveCampaign API URL (the pinned outbound fetch threw
// SsrfFetchError) is a clear 400, not a generic server error.

const mocks = vi.hoisted(() => ({
  runAction: vi.fn(),
  upsert: vi.fn(),
}))

vi.mock("@/lib/safe-action", () => {
  const chain: Record<string, unknown> = {}
  chain.bindArgsSchemas = () => chain
  chain.inputSchema = () => chain
  chain.action = (fn: unknown) => fn
  return { workspaceActionClient: chain }
})
vi.mock("@/features/common/schema", () => ({ workspaceIdrequestParams: [] }))
vi.mock("@/lib/log", () => ({ logger: { error: vi.fn() } }))
vi.mock("@chatbotx.io/business", () => ({
  integrationActiveCampaignService: { upsert: mocks.upsert },
}))
vi.mock("@chatbotx.io/integration-active-campaign", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@chatbotx.io/integration-active-campaign")
  >()),
  integration: { runAction: mocks.runAction },
}))
vi.mock("next-intl/server", () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}))

const { SsrfFetchError } = await import("@chatbotx.io/sdk/outbound-fetch")
const { SdkException } = await import("@chatbotx.io/sdk")
const { connectActiveCampaignAction } = await import(
  "../src/features/integration-active-campaign/actions/connect.action"
)

type Action = (args: unknown) => Promise<unknown>
const connect = connectActiveCampaignAction as unknown as Action
const call = () =>
  connect({
    bindArgsParsedInputs: ["ws-1"],
    parsedInput: { apiUrl: "http://169.254.169.254", apiKey: "k" },
  })

describe("connectActiveCampaignAction (s219)", () => {
  beforeEach(() => {
    mocks.runAction.mockReset()
    mocks.upsert.mockReset()
  })

  test("a refused API URL is a 400 naming the problem, and nothing is saved", async () => {
    mocks.runAction.mockRejectedValue(
      new SsrfFetchError(
        "unsafeAddress",
        "http://169.254.169.254/api/3/accounts",
      ),
    )
    const error = await call().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(SdkException)
    expect((error as InstanceType<typeof SdkException>).message).toBe(
      "unreachableApiUrl",
    )
    expect((error as InstanceType<typeof SdkException>).httpStatusCode).toBe(
      400,
    )
    expect(mocks.upsert).not.toHaveBeenCalled()
  })

  test("any other failure is rethrown unchanged", async () => {
    const boom = new TypeError("fetch failed")
    mocks.runAction.mockRejectedValue(boom)
    await expect(call()).rejects.toBe(boom)
  })
})
