import { describe, expect, test } from "vitest"
import { toPublicUploadUrl } from "../src/lib/uploader"

/**
 * s221b: on netcup every browser upload was signed for http://filesystem:9000
 * (the internal endpoint) and blocked as mixed content; the media library
 * never stored a file. The public base swaps only origin + bucket prefix.
 */
const SIGNED =
  "http://filesystem:9000/chatbotx/public/space/1/media-library/k1?X-Amz-Expires=300&X-Amz-Signature=abc"
const config = {
  endpoint: "http://filesystem:9000",
  bucket: "chatbotx",
  publicBase: "https://hub.test/storage",
}

describe("toPublicUploadUrl", () => {
  test("maps the internal endpoint + bucket to the public base, keeping key and signature", () => {
    expect(toPublicUploadUrl(SIGNED, config)).toBe(
      "https://hub.test/storage/public/space/1/media-library/k1?X-Amz-Expires=300&X-Amz-Signature=abc",
    )
  })

  test("trailing slashes on either base do not double or drop a separator", () => {
    expect(
      toPublicUploadUrl(SIGNED, {
        ...config,
        endpoint: "http://filesystem:9000/",
        publicBase: "https://hub.test/storage//",
      }),
    ).toBe(
      "https://hub.test/storage/public/space/1/media-library/k1?X-Amz-Expires=300&X-Amz-Signature=abc",
    )
  })

  test("unset public base or endpoint keeps today's behaviour", () => {
    expect(
      toPublicUploadUrl(SIGNED, { ...config, publicBase: undefined }),
    ).toBe(SIGNED)
    expect(toPublicUploadUrl(SIGNED, { ...config, endpoint: undefined })).toBe(
      SIGNED,
    )
  })

  test("a URL outside the endpoint + bucket prefix is never rewritten (no bucket or host confusion)", () => {
    for (const url of [
      "http://filesystem:9000/other-bucket/k1?sig",
      "http://filesystem:90000/chatbotx/k1?sig",
      "https://evil.test/http://filesystem:9000/chatbotx/k1",
      "http://filesystem:9000/chatbotxx/k1",
    ]) {
      expect(toPublicUploadUrl(url, config)).toBe(url)
    }
  })
})
