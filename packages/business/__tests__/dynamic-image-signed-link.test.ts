import { describe, expect, test, vi } from "vitest"
import {
  dynamicImageLinkOrigins,
  signDynamicImageLinksInStep,
  signDynamicImageUrl,
} from "../src/dynamic-image/signed-link"

const ORIGIN = "https://chat.example.org"
const origins = [ORIGIN]
const sign = vi.fn((id: string) => Promise.resolve(`tok-${id}`))
const TEMPLATE = `${ORIGIN}/dynamic-images?dynamicImageId=img-1&userId=11700000000000001`

describe("signDynamicImageUrl (s214)", () => {
  test("drops the forgeable userId and appends the token", async () => {
    const signed = new URL(
      await signDynamicImageUrl(TEMPLATE, { origins, sign }),
    )
    expect(signed.searchParams.get("userId")).toBeNull()
    expect(signed.searchParams.get("t")).toBe("tok-img-1")
    expect(signed.searchParams.get("dynamicImageId")).toBe("img-1")
    expect(signed.origin).toBe(ORIGIN)
  })

  test("re-signing replaces a stale token instead of adding a second", async () => {
    const once = await signDynamicImageUrl(TEMPLATE, { origins, sign })
    const twice = new URL(await signDynamicImageUrl(once, { origins, sign }))
    expect(twice.searchParams.getAll("t")).toEqual(["tok-img-1"])
  })

  test.each([
    [
      "another host",
      "https://evil.example.com/dynamic-images?dynamicImageId=img-1",
    ],
    [
      "a lookalike host",
      "https://chat.example.org.evil.com/dynamic-images?dynamicImageId=img-1",
    ],
    [
      "another scheme",
      "http://chat.example.org/dynamic-images?dynamicImageId=img-1",
    ],
    ["another path", `${ORIGIN}/dynamic-images/x?dynamicImageId=img-1`],
    ["no image id", `${ORIGIN}/dynamic-images?userId=1`],
    ["an unparsable URL", "not a url"],
    ["an empty string", ""],
  ])("leaves %s untouched and mints nothing", async (_label, url) => {
    sign.mockClear()
    expect(await signDynamicImageUrl(url, { origins, sign })).toBe(url)
    expect(sign).not.toHaveBeenCalled()
  })

  test("a mint failure propagates (never a silently unsigned send)", async () => {
    const failing = () => Promise.reject(new Error("no key"))
    await expect(
      signDynamicImageUrl(TEMPLATE, { origins, sign: failing }),
    ).rejects.toThrow("no key")
  })
})

describe("signDynamicImageLinksInStep (s214)", () => {
  test("sendImage url", async () => {
    const step = { id: "s", stepType: "sendImage", url: TEMPLATE }
    const out = await signDynamicImageLinksInStep(step, { origins, sign })
    expect(new URL(out.url).searchParams.get("t")).toBe("tok-img-1")
    expect(out.id).toBe("s")
  })

  test("bulktextSend photoUrl (the line worker fetches it)", async () => {
    const step = {
      id: "s",
      stepType: "bulktextSend",
      text: "hi",
      photoUrl: TEMPLATE,
    }
    const out = await signDynamicImageLinksInStep(step, { origins, sign })
    expect(new URL(out.photoUrl).searchParams.get("t")).toBe("tok-img-1")
    expect(new URL(out.photoUrl).searchParams.get("userId")).toBeNull()
    expect(out.text).toBe("hi")
  })

  test("sendMultipleImages images[].url, other entries untouched", async () => {
    const step = {
      id: "s",
      images: [
        { id: "a", url: TEMPLATE },
        { id: "b", url: "https://cdn.example.com/x.png" },
        null,
        "junk",
      ],
    }
    const out = await signDynamicImageLinksInStep(step, { origins, sign })
    expect(
      new URL((out.images[0] as { url: string }).url).searchParams.get("t"),
    ).toBe("tok-img-1")
    expect(out.images.slice(1)).toEqual(step.images.slice(1))
  })

  test("cards[].image.url, cards without an image untouched", async () => {
    const step = {
      id: "s",
      cards: [
        { id: "c1", image: { url: TEMPLATE } },
        { id: "c2", title: "no image" },
        { id: "c3", image: null },
      ],
    }
    const out = await signDynamicImageLinksInStep(step, { origins, sign })
    expect(
      new URL(
        (out.cards[0] as { image: { url: string } }).image.url,
      ).searchParams.get("t"),
    ).toBe("tok-img-1")
    expect(out.cards.slice(1)).toEqual(step.cards.slice(1))
  })

  test("a step with no image fields comes back as the same object", async () => {
    const step = { id: "s", stepType: "bulktextSend", text: TEMPLATE }
    expect(await signDynamicImageLinksInStep(step, { origins, sign })).toBe(
      step,
    )
  })
})

describe("dynamicImageLinkOrigins (s214)", () => {
  test("includes the tenant app URL origin, deduplicated and path-free", () => {
    const list = dynamicImageLinkOrigins("https://tenant.example.net/some/path")
    expect(list).toContain("https://tenant.example.net")
    expect(new Set(list).size).toBe(list.length)
  })

  test("a malformed tenant URL contributes nothing (the env origins stay)", () => {
    const list = dynamicImageLinkOrigins("::::")
    expect(list.every((o) => o.startsWith("http"))).toBe(true)
  })
})
