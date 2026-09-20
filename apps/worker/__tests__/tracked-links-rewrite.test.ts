// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from "vitest"

const TRAILING_SLASHES = /\/+$/
const mint = vi.fn()
const mintPixel = vi.fn()
vi.mock("@chatbotx.io/business", () => ({
  trackedLinkService: {
    mint: (...args: unknown[]) => mint(...args),
    mintPixel: (...args: unknown[]) => mintPixel(...args),
  },
  buildTrackedPixelUrl: (appUrl: string, token: string) =>
    `${appUrl.replace(TRAILING_SLASHES, "")}/go/${token}/o`,
  buildTrackedLinkUrl: (appUrl: string, token: string) =>
    `${appUrl.replace(TRAILING_SLASHES, "")}/go/${token}`,
}))

const { rewriteTrackedLinks, trackBulktextLinksInStep } = await import(
  "../src/chat/lib/tracked-links"
)

const APP = "https://hub.example"

beforeEach(() => {
  mintPixel.mockReset()
  mintPixel.mockImplementation(() => Promise.resolve("pix00000001"))
  mint.mockReset()
  let n = 0
  mint.mockImplementation(() => Promise.resolve(`tok${++n}`))
})

describe("rewriteTrackedLinks", () => {
  test("replaces every URL, one token per occurrence, in order", async () => {
    const seen: string[] = []
    const out = await rewriteTrackedLinks(
      "a https://x.y/one and http://z.w/two?q=1 end",
      APP,
      (url) => {
        seen.push(url)
        return Promise.resolve(`t${seen.length}`)
      },
    )
    expect(out).toEqual({
      text: "a https://hub.example/go/t1 and https://hub.example/go/t2 end",
      minted: 2,
    })
    expect(seen).toEqual(["https://x.y/one", "http://z.w/two?q=1"])
  })

  test("trailing sentence punctuation stays outside the link", async () => {
    const out = await rewriteTrackedLinks(
      "see https://x.y/z. Or (https://x.y/q), ok?",
      APP,
      (url) => Promise.resolve(`k:${url.length}`),
    )
    expect(out.text).toBe(
      "see https://hub.example/go/k:13. Or (https://hub.example/go/k:13), ok?",
    )
  })

  test("a URL already under /go/ is left alone", async () => {
    const mintSpy = vi.fn(() => Promise.resolve("new"))
    const out = await rewriteTrackedLinks(
      `tap ${APP}/go/AbCdEfGhIjK now`,
      APP,
      mintSpy,
    )
    expect(out).toEqual({ text: `tap ${APP}/go/AbCdEfGhIjK now`, minted: 0 })
    expect(mintSpy).not.toHaveBeenCalled()
  })

  test("no URL means no mint and the same text", async () => {
    const mintSpy = vi.fn(() => Promise.resolve("new"))
    const out = await rewriteTrackedLinks("plain text", APP, mintSpy)
    expect(out).toEqual({ text: "plain text", minted: 0 })
    expect(mintSpy).not.toHaveBeenCalled()
  })

  test("a mint failure propagates (the operator opted in)", async () => {
    await expect(
      rewriteTrackedLinks("https://x.y", APP, () =>
        Promise.reject(new Error("db down")),
      ),
    ).rejects.toThrow("db down")
  })
})

describe("trackBulktextLinksInStep", () => {
  const base = {
    workspaceId: "w1",
    contactId: "c1",
    contactInboxId: "ci1",
    flowId: "f1",
    appUrl: APP,
  }

  test("rewrites a bulktextSend step with trackLinks on and records attribution", async () => {
    const step = {
      id: "s1",
      stepType: "bulktextSend",
      text: "hi https://x.y/p",
      trackLinks: true,
    } as never
    const out = await trackBulktextLinksInStep({ ...base, step })
    expect((out as { text: string }).text).toBe(
      "hi https://hub.example/go/tok1",
    )
    expect(mint).toHaveBeenCalledWith({
      workspaceId: "w1",
      contactId: "c1",
      contactInboxId: "ci1",
      flowId: "f1",
      stepId: "s1",
      url: "https://x.y/p",
    })
  })

  test("leaves the step untouched when trackLinks is off, the type differs, or the text is empty", async () => {
    for (const step of [
      {
        id: "s",
        stepType: "bulktextSend",
        text: "https://x.y",
        trackLinks: false,
      },
      { id: "s", stepType: "sendText", text: "https://x.y" },
      { id: "s", stepType: "bulktextSend", text: "", trackLinks: true },
    ]) {
      const out = await trackBulktextLinksInStep({
        ...base,
        step: step as never,
      })
      expect(out).toBe(step)
    }
    expect(mint).not.toHaveBeenCalled()
  })

  test("trackOpens mints a pixel and fills openPixel; links and opens compose; neither touches a step that asked for nothing", async () => {
    const opens = {
      id: "s2",
      stepType: "bulktextSend",
      text: "plain",
      trackLinks: false,
      trackOpens: true,
      openPixel: "",
    } as never
    const out = await trackBulktextLinksInStep({ ...base, step: opens })
    expect(out).toMatchObject({
      text: "plain",
      openPixel: "https://hub.example/go/pix00000001/o",
    })
    expect(mintPixel).toHaveBeenCalledWith({
      workspaceId: "w1",
      contactId: "c1",
      contactInboxId: "ci1",
      flowId: "f1",
      stepId: "s2",
    })
    expect(mint).not.toHaveBeenCalled()
    const both = {
      ...opens,
      text: "see https://x.y",
      trackLinks: true,
    } as never
    const out2 = await trackBulktextLinksInStep({ ...base, step: both })
    expect(out2).toMatchObject({
      text: "see https://hub.example/go/tok1",
      openPixel: "https://hub.example/go/pix00000001/o",
    })
    const none = { ...opens, trackOpens: false } as never
    expect(await trackBulktextLinksInStep({ ...base, step: none })).toBe(none)
  })
})
