// @vitest-environment node
import { beforeEach, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  handleCallback: vi.fn(async () => new Response("callback")),
  handleWebhook: vi.fn(async () => new Response("webhook")),
  notFound: vi.fn(() => new Response("not found", { status: 404 })),
}))

vi.mock("../src/app/integrations/[...integration]/callback", () => ({
  handleCallback: mocks.handleCallback,
}))
vi.mock("../src/app/integrations/[...integration]/webhook", () => ({
  handleWebhook: mocks.handleWebhook,
}))
vi.mock("next/navigation", () => ({ notFound: mocks.notFound }))

const { GET, POST } = await import(
  "../src/app/integrations/[...integration]/route"
)

const hit = (handler: typeof GET, segments: string[]) =>
  handler(
    new Request(
      `https://hub.example/integrations/${segments.join("/")}`,
    ) as never,
    { params: Promise.resolve({ integration: segments }) },
  )

beforeEach(() => vi.clearAllMocks())

test("routes exactly /<type>/<action> (s230a)", async () => {
  await hit(POST, ["zalo", "webhook"])
  await hit(GET, ["zalo", "callback"])
  expect(mocks.handleWebhook).toHaveBeenCalledWith("zalo", expect.anything())
  expect(mocks.handleCallback).toHaveBeenCalledWith("zalo", expect.anything())
})

test("an extra segment never reaches a handler: /zalo/webhook/callback would run the OAuth callback past the webhook route", async () => {
  for (const segments of [
    ["zalo", "webhook", "callback"],
    ["zalo", "webhook", "webhook"],
    ["messenger", "callback", "webhook"],
    ["zalo"],
  ]) {
    await hit(POST, segments)
    await hit(GET, segments)
  }
  expect(mocks.handleWebhook).not.toHaveBeenCalled()
  expect(mocks.handleCallback).not.toHaveBeenCalled()
  expect(mocks.notFound).toHaveBeenCalledTimes(8)
})
