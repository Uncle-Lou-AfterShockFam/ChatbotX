import { beforeEach, describe, expect, test, vi } from "vitest"

// s216: POST/PUT /v1/dynamic-images answered 500 when an image element's URL
// was refused (the s215 SSRF guard) or unreachable. That is the caller's
// input: a 422 naming the URL, and nothing is uploaded or inserted.
vi.hoisted(() => {
  process.env.ENCRYPTION_KEY ??= "b".repeat(64)
})

const mocks = vi.hoisted(() => ({
  renderStaticLayer: vi.fn(),
  putObject: vi.fn(),
  insert: vi.fn(),
}))

vi.mock("../src/dynamic-image/render", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  renderStaticLayer: mocks.renderStaticLayer,
}))

vi.mock("@chatbotx.io/filesystem", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  uploader: { putObject: mocks.putObject },
}))

vi.mock("@chatbotx.io/database/client", async (importOriginal) => {
  const actual = await importOriginal<{ db: object }>()
  return { ...actual, db: { ...actual.db, insert: mocks.insert } }
})

const { ChatbotXException } = await import("../src/errors")
const { ImageFetchRefusedError } = await import(
  "../src/dynamic-image/pinned-fetch"
)
const { dynamicImageService } = await import("../src/dynamic-image/service")

const input = {
  workspaceId: "ws-1",
  name: "refused",
  customFieldId: "cf-1",
  data: { width: 10, height: 10, elements: [] },
} as unknown as Parameters<typeof dynamicImageService.create>[0]

describe("dynamic-image create: a refused image URL is a 422 (s216)", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      mock.mockReset()
    }
  })

  test.each([
    ["unsafeAddress", "localtest.me"],
    ["unsafeUrl", "http://169.254.169.254/latest"],
    ["unreachable", "http://nowhere.test/x.png"],
  ] as const)("%s -> validation 422 naming the URL", async (reason, detail) => {
    mocks.renderStaticLayer.mockRejectedValue(
      new ImageFetchRefusedError(reason, detail),
    )
    const error = await dynamicImageService.create(input).then(
      () => null,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(ChatbotXException)
    expect(error).toMatchObject({
      code: "validation",
      httpStatusCode: 422,
      field: "data",
      data: { reason },
    })
    expect((error as Error).message).toContain(detail)
    expect(mocks.putObject).not.toHaveBeenCalled()
    expect(mocks.insert).not.toHaveBeenCalled()
  })

  test("any other render failure stays a server error", async () => {
    const crash = new Error("canvas exploded")
    mocks.renderStaticLayer.mockRejectedValue(crash)
    await expect(dynamicImageService.create(input)).rejects.toBe(crash)
  })
})
