// @vitest-environment node
import { describe, expect, test } from "vitest"
import { isLinkPrefetch, isPreviewUserAgent } from "@/lib/tracked-link/prefetch"

const IMESSAGE_PREVIEW_UA = "facebookexternalhit/1.1 Facebot Twitterbot/1.0"
const IPHONE_SAFARI_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
const ANDROID_CHROME_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36"

const req = (headers: Record<string, string>, method = "GET") =>
  new Request("http://localhost/l/AbCdEfGhIjK", { method, headers })

describe("isLinkPrefetch", () => {
  test("an iMessage link preview is a prefetch", () => {
    expect(isLinkPrefetch(req({ "user-agent": IMESSAGE_PREVIEW_UA }))).toBe(
      true,
    )
  })

  test("a phone browser navigation is a click", () => {
    for (const ua of [IPHONE_SAFARI_UA, ANDROID_CHROME_UA]) {
      expect(
        isLinkPrefetch(
          req({
            "user-agent": ua,
            "sec-fetch-dest": "document",
            "sec-fetch-mode": "navigate",
          }),
        ),
      ).toBe(false)
      expect(isLinkPrefetch(req({ "user-agent": ua }))).toBe(false)
    }
  })

  test("non-navigation fetch metadata, a prefetch purpose, or a non-GET is a prefetch", () => {
    expect(
      isLinkPrefetch(
        req({ "user-agent": IPHONE_SAFARI_UA, "sec-fetch-dest": "image" }),
      ),
    ).toBe(true)
    expect(
      isLinkPrefetch(
        req({ "user-agent": IPHONE_SAFARI_UA, "sec-fetch-mode": "cors" }),
      ),
    ).toBe(true)
    expect(
      isLinkPrefetch(
        req({ "user-agent": IPHONE_SAFARI_UA, purpose: "prefetch" }),
      ),
    ).toBe(true)
    expect(
      isLinkPrefetch(req({ "user-agent": IPHONE_SAFARI_UA }, "HEAD")),
    ).toBe(true)
  })

  test("a missing or empty user agent, curl, and generic bots are prefetches", () => {
    expect(isPreviewUserAgent(null)).toBe(true)
    expect(isPreviewUserAgent("")).toBe(true)
    expect(isPreviewUserAgent("curl/8.4.0")).toBe(true)
    expect(isPreviewUserAgent("Slackbot-LinkExpanding 1.0")).toBe(true)
    expect(isPreviewUserAgent("SomethingBot/2.0")).toBe(true)
  })
})
