import { afterAll, beforeAll, describe, expect, test, vi } from "vitest"

/**
 * s222b: signed DOWNLOADS had the same self-host gap #131 closed for uploads:
 * signed for http://filesystem:9000, unreachable from a browser or from a
 * bulktext email line fetching a newsletter attachment. The swap is the
 * upload one: origin + bucket prefix only, key and signature kept.
 */
const HEX_SIGNATURE = /^[0-9a-f]{64}$/

describe("Uploader.getPresignedDownload", () => {
  beforeAll(() => {
    vi.stubEnv("S3_ENDPOINT", "http://filesystem:9000")
    vi.stubEnv("S3_BUCKET", "chatbotx")
    vi.stubEnv("S3_REGION", "us-east-1")
    vi.stubEnv("S3_ACCESS_KEY_ID", "AKIDEXAMPLE")
    vi.stubEnv("S3_SECRET_ACCESS_KEY", "secret")
    vi.stubEnv("S3_PUBLIC_UPLOAD_URL", "https://hub.test/storage")
    vi.resetModules()
  })
  afterAll(() => {
    vi.unstubAllEnvs()
  })

  test("is signed for the endpoint and served under the public base, with the requested expiry", async () => {
    const { uploader } = await import("../src/lib/uploader")
    const url = new URL(
      await uploader.getPresignedDownload("public/space/1/media/a.pdf", 86_400),
    )
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://hub.test/storage/public/space/1/media/a.pdf",
    )
    expect(url.searchParams.get("X-Amz-Expires")).toBe("86400")
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(HEX_SIGNATURE)
    // SigV4 signed the INTERNAL host; the proxy restores it (Caddyfile).
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host")
  })
})
