// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from "vitest"

const TRAILING_SLASHES = /\/+$/
const mint = vi.fn()
vi.mock("@chatbotx.io/business", () => ({
  trackedLinkService: { mint: (...args: unknown[]) => mint(...args) },
  buildTrackedLinkUrl: (appUrl: string, token: string) =>
    `${appUrl.replace(TRAILING_SLASHES, "")}/l/${token}`,
}))

const { rewriteTrackedLinks, trackBulktextLinksInStep } = await import(
  "../src/chat/lib/tracked-links"
)

const APP = "https://hub.example"

beforeEach(() => {
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
      text: "a https://hub.example/l/t1 and https://hub.example/l/t2 end",
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
      "see https://hub.example/l/k:13. Or (https://hub.example/l/k:13), ok?",
    )
  })

  test("a URL already under /l/ is left alone", async () => {
    const mintSpy = vi.fn(() => Promise.resolve("new"))
    const out = await rewriteTrackedLinks(
      `tap ${APP}/l/AbCdEfGhIjK now`,
      APP,
      mintSpy,
    )
    expect(out).toEqual({ text: `tap ${APP}/l/AbCdEfGhIjK now`, minted: 0 })
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
    expect((out as { text: string }).text).toBe("hi https://hub.example/l/tok1")
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
})
