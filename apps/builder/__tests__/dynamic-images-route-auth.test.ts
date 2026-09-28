// @vitest-environment node

import { NextRequest } from "next/server"
import { beforeEach, describe, expect, test, vi } from "vitest"

vi.hoisted(() => {
  process.env.ENCRYPTION_KEY ??= "a".repeat(64)
})

const mocks = vi.hoisted(() => ({
  findUnscoped: vi.fn(),
  resolveBackgroundUrl: vi.fn(),
  findCachedUrlForContact: vi.fn(),
  resolveDynamicElements: vi.fn(),
  renderForContact: vi.fn(),
  findInWorkspace: vi.fn(),
  resolveContactVariablesDeep: vi.fn(),
  checkDynamicImageRateLimit: vi.fn(),
}))

vi.mock("@/lib/rate-limit/dynamic-image-rate-limit", () => ({
  checkDynamicImageRateLimit: mocks.checkDynamicImageRateLimit,
}))

vi.mock("@chatbotx.io/business", () => ({
  contactInboxService: { findInWorkspace: mocks.findInWorkspace },
}))

vi.mock("@chatbotx.io/business/dynamic-image", () => ({
  dynamicImageService: {
    findUnscoped: mocks.findUnscoped,
    resolveBackgroundUrl: mocks.resolveBackgroundUrl,
    findCachedUrlForContact: mocks.findCachedUrlForContact,
    resolveDynamicElements: mocks.resolveDynamicElements,
    renderForContact: mocks.renderForContact,
  },
  getDynamicElementIds: () => new Set<string>(),
}))

vi.mock("@chatbotx.io/variables", () => ({
  resolveContactVariablesDeep: mocks.resolveContactVariablesDeep,
}))

vi.mock("@/lib/workspace/load-servable-workspace", () => ({
  loadServableWorkspace: async () => ({ servable: true }),
}))

const { signDynamicImageToken } = await import(
  "@chatbotx.io/encryption/dynamic-image-token"
)
const { signMinigamePlayToken } = await import(
  "@chatbotx.io/encryption/minigame-play-token"
)
const { GET } = await import("../src/app/dynamic-images/route")

const WS = "11701868563365888"
const IMAGE = { id: "img-1", workspaceId: WS, enabled: true, data: {} }
const BACKGROUND = "https://storage.example.org/bg.png"
const RENDERED = "https://storage.example.org/contacts/c-1-tag.png"
const CLAIMS = {
  workspaceId: WS,
  dynamicImageId: "img-1",
  contactId: "contact-1",
  contactInboxId: "ci-1",
}

const get = (query: string) =>
  GET(new NextRequest(`https://chat.example.org/dynamic-images?${query}`))

describe("GET /dynamic-images: signed contact links only (s214)", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      mock.mockReset()
    }
    mocks.findUnscoped.mockResolvedValue(IMAGE)
    mocks.resolveBackgroundUrl.mockResolvedValue(BACKGROUND)
    mocks.findCachedUrlForContact.mockResolvedValue(null)
    mocks.resolveDynamicElements.mockResolvedValue({})
    mocks.resolveContactVariablesDeep.mockResolvedValue({})
    mocks.renderForContact.mockResolvedValue(RENDERED)
    mocks.checkDynamicImageRateLimit.mockResolvedValue({
      limited: false,
      retryAfter: 0,
    })
    mocks.findInWorkspace.mockResolvedValue({
      id: "ci-1",
      contactId: "contact-1",
    })
  })

  test("a bare userId (the old forgeable identity) gets only the background", async () => {
    const res = await get("dynamicImageId=img-1&userId=%2B15550001234")
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe(BACKGROUND)
    expect(mocks.findInWorkspace).not.toHaveBeenCalled()
    expect(mocks.renderForContact).not.toHaveBeenCalled()
  })

  test("a valid token renders for exactly the signed contact", async () => {
    const t = await signDynamicImageToken(CLAIMS)
    const res = await get(`dynamicImageId=img-1&t=${t}&userId=someone-else`)
    expect(res.headers.get("location")).toBe(RENDERED)
    expect(mocks.findInWorkspace).toHaveBeenCalledWith({
      id: "ci-1",
      contactId: "contact-1",
      workspaceId: WS,
    })
    expect(mocks.renderForContact).toHaveBeenCalledWith(
      expect.objectContaining({ contactId: "contact-1", workspaceId: WS }),
    )
  })

  test("a valid token serves the cached render when one exists", async () => {
    mocks.findCachedUrlForContact.mockResolvedValue(`${RENDERED}?timestamp=1`)
    const t = await signDynamicImageToken(CLAIMS)
    const res = await get(`dynamicImageId=img-1&t=${t}`)
    expect(res.headers.get("location")).toBe(`${RENDERED}?timestamp=1`)
    expect(mocks.renderForContact).not.toHaveBeenCalled()
  })

  test.each([
    ["an expired token", async () => await signDynamicImageToken(CLAIMS, -1)],
    [
      "a token for another image",
      async () =>
        await signDynamicImageToken({ ...CLAIMS, dynamicImageId: "img-2" }),
    ],
    [
      "a token for another workspace",
      async () =>
        await signDynamicImageToken({ ...CLAIMS, workspaceId: "999" }),
    ],
    [
      "a token minted for another purpose",
      async () => await signMinigamePlayToken(CLAIMS),
    ],
    ["garbage", async () => await Promise.resolve("not-a-token")],
    ["an empty token", async () => await Promise.resolve("")],
  ])("%s gets only the background", async (_label, mint) => {
    const t = await mint()
    const res = await get(`dynamicImageId=img-1&t=${encodeURIComponent(t)}`)
    expect(res.headers.get("location")).toBe(BACKGROUND)
    expect(mocks.renderForContact).not.toHaveBeenCalled()
  })

  test("a valid token whose contact inbox is gone (or not in the workspace) gets the background", async () => {
    mocks.findInWorkspace.mockResolvedValue(undefined)
    const t = await signDynamicImageToken(CLAIMS)
    const res = await get(`dynamicImageId=img-1&t=${t}`)
    expect(res.headers.get("location")).toBe(BACKGROUND)
    expect(mocks.renderForContact).not.toHaveBeenCalled()
  })

  test("no dynamicImageId is a 400; a disabled image is a 404", async () => {
    expect((await get("t=x")).status).toBe(400)
    mocks.findUnscoped.mockResolvedValue({ ...IMAGE, enabled: false })
    expect((await get("dynamicImageId=img-1")).status).toBe(404)
  })

  test("past the render budget the signed link degrades to the background (s219)", async () => {
    mocks.checkDynamicImageRateLimit.mockResolvedValue({
      limited: true,
      retryAfter: 30,
    })
    const t = await signDynamicImageToken(CLAIMS)
    const res = await get(`dynamicImageId=img-1&t=${t}`)
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe(BACKGROUND)
    expect(mocks.checkDynamicImageRateLimit).toHaveBeenCalledWith({
      dynamicImageId: "img-1",
      contactId: "contact-1",
    })
    expect(mocks.renderForContact).not.toHaveBeenCalled()
  })

  test("a cached render is served without spending the render budget (s219)", async () => {
    mocks.findCachedUrlForContact.mockResolvedValue(`${RENDERED}?timestamp=1`)
    const t = await signDynamicImageToken(CLAIMS)
    await get(`dynamicImageId=img-1&t=${t}`)
    expect(mocks.checkDynamicImageRateLimit).not.toHaveBeenCalled()
  })

  test("an unsigned request never spends the render budget (s219)", async () => {
    await get("dynamicImageId=img-1")
    expect(mocks.checkDynamicImageRateLimit).not.toHaveBeenCalled()
  })
})
