// @vitest-environment node

import { afterEach, describe, expect, test, vi } from "vitest"

// s216: barrel code (contact avatars, AI files, flow-step media, logos) reaches
// user URLs only through `outboundFetch`, which the Node process installs.
const mocks = vi.hoisted(() => ({ putObject: vi.fn() }))

vi.mock("@chatbotx.io/filesystem", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  uploader: { putObject: mocks.putObject },
}))

const { uploadFileFromUrl, UploadValidationError } = await import(
  "@chatbotx.io/filesystem"
)
const {
  OutboundFetchNotInstalledError,
  outboundDownload,
  outboundFetch,
  registerOutboundFetch,
  uninstallOutboundFetch: uninstall,
} = await import("../src/net/outbound-fetch")
const { SsrfFetchError } = await import("../src/net/safe-fetch")
const { installPinnedOutboundFetch } = await import("../src/net-node")

afterEach(() => {
  uninstall()
  mocks.putObject.mockReset()
})

describe("outboundFetch registry (s216)", () => {
  test("fails closed when the process never installed the pinned fetch", async () => {
    uninstall()
    await expect(outboundFetch("https://example.com/")).rejects.toBeInstanceOf(
      OutboundFetchNotInstalledError,
    )
    await expect(
      outboundDownload("https://example.com/"),
    ).rejects.toBeInstanceOf(OutboundFetchNotInstalledError)
  })

  test("routes through whatever was registered, passing init and options", async () => {
    const impl = vi.fn(async () => new Response("ok"))
    registerOutboundFetch(impl)
    await outboundFetch(
      "https://example.com/a",
      { method: "POST" },
      {
        timeoutMs: 5,
      },
    )
    expect(impl).toHaveBeenCalledWith(
      "https://example.com/a",
      { method: "POST" },
      { timeoutMs: 5 },
    )
    await outboundDownload("https://example.com/b")
    expect(impl).toHaveBeenLastCalledWith(
      "https://example.com/b",
      {},
      {
        timeoutMs: 120_000,
      },
    )
  })

  test.each([
    "http://169.254.169.254/latest/meta-data",
    "http://127.0.0.1:9000/bucket/secret",
    "http://[::1]/x",
    "http://localhost/x",
    "file:///etc/passwd",
  ])("installed: %s is refused before any socket reaches it", async (url) => {
    installPinnedOutboundFetch()
    await expect(outboundFetch(url)).rejects.toBeInstanceOf(SsrfFetchError)
  })

  test("installed, end to end: an internal avatar URL is refused and nothing is stored", async () => {
    installPinnedOutboundFetch()
    const error = await uploadFileFromUrl(
      "http://169.254.169.254/latest/meta-data/iam",
      "public/space/ws-1/contacts/c-1/avatar/x",
      { fetchImpl: outboundDownload },
    ).then(
      () => null,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(UploadValidationError)
    expect((error as Error).message).toBe("The provided URL is not allowed")
    expect(mocks.putObject).not.toHaveBeenCalled()
  })
})
