// @vitest-environment node
import { describe, expect, test } from "vitest"
import {
  rewriteTrackedLinks,
  shouldRewriteUrl,
} from "../src/tracked-link/rewrite"
import { MAX_TRACKED_LINK_URL_LENGTH } from "../src/tracked-link/url"

const APP = "https://hub.example/"
const LONG = `https://hub.example/booking/picker?token=${"x".repeat(80)}`

describe("shouldRewriteUrl", () => {
  test("default: every URL except one already under /go/ or over the mint bound", () => {
    expect(shouldRewriteUrl("https://x.y/a", APP)).toBe(true)
    expect(shouldRewriteUrl("https://hub.example/go/tok00000001", APP)).toBe(
      false,
    )
    expect(
      shouldRewriteUrl(
        `https://x.y/${"a".repeat(MAX_TRACKED_LINK_URL_LENGTH)}`,
        APP,
      ),
    ).toBe(false)
  })

  test("minLength keeps a short URL verbatim and rewrites a long one", () => {
    expect(shouldRewriteUrl("https://x.y/a", APP, { minLength: 60 })).toBe(
      false,
    )
    expect(shouldRewriteUrl(LONG, APP, { minLength: 60 })).toBe(true)
    // Exactly the threshold qualifies.
    const exact = `https://x.y/${"b".repeat(60 - "https://x.y/".length)}`
    expect(exact.length).toBe(60)
    expect(shouldRewriteUrl(exact, APP, { minLength: 60 })).toBe(true)
  })
})

describe("rewriteTrackedLinks", () => {
  test("with minLength, only long URLs are minted and the short one stays in place", async () => {
    const seen: string[] = []
    const out = await rewriteTrackedLinks(
      `book https://x.y/a or ${LONG}.`,
      APP,
      (url) => {
        seen.push(url)
        return Promise.resolve(`t${seen.length}`)
      },
      { minLength: 60 },
    )
    expect(out).toEqual({
      text: "book https://x.y/a or https://hub.example/go/t1.",
      minted: 1,
    })
    expect(seen).toEqual([LONG])
  })

  test("a URL over the mint bound is left alone instead of failing the send", async () => {
    const huge = `https://x.y/${"z".repeat(MAX_TRACKED_LINK_URL_LENGTH)}`
    const out = await rewriteTrackedLinks(`see ${huge}`, APP, () =>
      Promise.reject(new Error("must not mint")),
    )
    expect(out).toEqual({ text: `see ${huge}`, minted: 0 })
  })

  test("an empty text is a no-op", async () => {
    const out = await rewriteTrackedLinks("", APP, () =>
      Promise.reject(new Error("must not mint")),
    )
    expect(out).toEqual({ text: "", minted: 0 })
  })
})
