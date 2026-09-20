// @vitest-environment node
import { describe, expect, test, vi } from "vitest"

const { mockInsertValues, mockUpdate, mockSelect } = vi.hoisted(() => ({
  mockInsertValues: vi.fn().mockResolvedValue(undefined),
  mockUpdate: vi.fn(),
  mockSelect: vi.fn(),
}))

vi.mock("@chatbotx.io/database/client", () => ({
  db: {
    insert: () => ({ values: mockInsertValues }),
    update: () => ({
      set: (s: unknown) => ({
        where: (w: unknown) => ({ returning: () => mockUpdate(s, w) }),
      }),
    }),
    select: () => ({
      from: () => ({ where: (w: unknown) => ({ limit: () => mockSelect(w) }) }),
    }),
  },
  eq: (...a: unknown[]) => ({ eq: a }),
  and: (...a: unknown[]) => ({ and: a }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
    {},
  ),
}))

vi.mock("@chatbotx.io/database/schema", () => ({
  trackedLinkModel: {
    token: "token",
    kind: "kind",
    openCount: "openCount",
    firstOpenedAt: "firstOpenedAt",
    clickCount: "clickCount",
    prefetchCount: "prefetchCount",
    firstClickedAt: "firstClickedAt",
  },
}))
vi.mock("@chatbotx.io/redis", () => ({ invalidateCacheByTags: vi.fn() }))
vi.mock("../src/audit/dispatcher", () => ({ dispatchAuditRecord: vi.fn() }))

const {
  buildTrackedPixelUrl,
  buildTrackedLinkUrl,
  isTrackedLinkToken,
  mintTrackedLinkToken,
  TRACKED_LINK_TOKEN_LENGTH,
  trackedLinkService,
} = await import("../src/tracked-link/service")

const BASE62 = /^[0-9A-Za-z]+$/

describe("tokens", () => {
  test("11 base62 characters from 8 random bytes; the full 64-bit range fits", () => {
    for (const bytes of [
      new Uint8Array(8),
      new Uint8Array(8).fill(255),
      new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    ]) {
      const token = mintTrackedLinkToken(() => bytes)
      expect(token).toHaveLength(TRACKED_LINK_TOKEN_LENGTH)
      expect(token).toMatch(BASE62)
      expect(isTrackedLinkToken(token)).toBe(true)
    }
    expect(mintTrackedLinkToken(() => new Uint8Array(8))).toBe("00000000000")
  })

  test("two mints differ and the default source is random", () => {
    expect(mintTrackedLinkToken()).not.toBe(mintTrackedLinkToken())
  })

  test("isTrackedLinkToken rejects the wrong length, alphabet, and type", () => {
    expect(isTrackedLinkToken("AbCdEfGhIj")).toBe(false)
    expect(isTrackedLinkToken("AbCdEfGhIjK-")).toBe(false)
    expect(isTrackedLinkToken("AbCdEfGh/jK")).toBe(false)
    expect(isTrackedLinkToken(null)).toBe(false)
    expect(isTrackedLinkToken(12_345_678_901)).toBe(false)
  })

  test("buildTrackedLinkUrl strips a trailing slash from the app URL", () => {
    expect(buildTrackedLinkUrl("https://hub.x/", "AbCdEfGhIjK")).toBe(
      "https://hub.x/go/AbCdEfGhIjK",
    )
    expect(buildTrackedLinkUrl("https://hub.x", "AbCdEfGhIjK")).toBe(
      "https://hub.x/go/AbCdEfGhIjK",
    )
  })
})

describe("trackedLinkService", () => {
  const input = {
    workspaceId: "w1",
    contactId: "c1",
    contactInboxId: "ci1",
    flowId: "f1",
    stepId: "s1",
  }

  test("mint validates the URL and inserts one row with attribution", async () => {
    mockInsertValues.mockClear()
    const token = await trackedLinkService.mint({
      ...input,
      url: "https://x.y/p?q=1",
    })
    expect(isTrackedLinkToken(token)).toBe(true)
    expect(mockInsertValues).toHaveBeenCalledWith({
      token,
      ...input,
      url: "https://x.y/p?q=1",
    })
    for (const url of [
      "javascript:alert(1)",
      "ftp://x",
      "x.y",
      "",
      `https://${"a".repeat(2050)}`,
    ]) {
      await expect(trackedLinkService.mint({ ...input, url })).rejects.toThrow(
        TypeError,
      )
    }
    await expect(
      trackedLinkService.mint({ ...input, url: 5 as never }),
    ).rejects.toThrow(TypeError)
  })

  test("findByToken short-circuits a malformed token without a query", async () => {
    mockSelect.mockClear()
    expect(await trackedLinkService.findByToken("nope")).toBeUndefined()
    expect(mockSelect).not.toHaveBeenCalled()
    mockSelect.mockResolvedValueOnce([{ token: "AbCdEfGhIjK" }])
    expect(await trackedLinkService.findByToken("AbCdEfGhIjK")).toEqual({
      token: "AbCdEfGhIjK",
    })
  })

  test("recordVisit bumps clicks for a click and only prefetches for a preview", async () => {
    mockUpdate.mockReset()
    mockUpdate.mockResolvedValue([{ token: "AbCdEfGhIjK" }])
    const now = new Date("2026-09-20T10:00:00Z")
    await trackedLinkService.recordVisit("AbCdEfGhIjK", "click", now)
    const [clickSet] = mockUpdate.mock.calls[0] as [Record<string, unknown>]
    expect(Object.keys(clickSet).sort()).toEqual([
      "clickCount",
      "firstClickedAt",
      "lastClickedAt",
    ])
    expect(clickSet.lastClickedAt).toBe(now)
    await trackedLinkService.recordVisit("AbCdEfGhIjK", "prefetch", now)
    const [prefetchSet] = mockUpdate.mock.calls[1] as [Record<string, unknown>]
    expect(Object.keys(prefetchSet)).toEqual(["prefetchCount"])
    expect(
      await trackedLinkService.recordVisit("bad", "click", now),
    ).toBeUndefined()
    expect(mockUpdate).toHaveBeenCalledTimes(2)
  })

  test("mintPixel inserts a kind=pixel row with an empty url; recordOpen bumps opens on pixel rows only; the pixel URL ends in /o", async () => {
    mockInsertValues.mockClear()
    const token = await trackedLinkService.mintPixel({ ...input })
    expect(isTrackedLinkToken(token)).toBe(true)
    expect(mockInsertValues).toHaveBeenCalledWith({
      token,
      kind: "pixel",
      ...input,
      url: "",
    })
    mockUpdate.mockReset()
    mockUpdate.mockResolvedValue([{ token }])
    const now = new Date("2026-09-20T10:00:00Z")
    await trackedLinkService.recordOpen(token, now)
    const [set, where] = mockUpdate.mock.calls[0] as [
      Record<string, unknown>,
      unknown,
    ]
    expect(Object.keys(set).sort()).toEqual([
      "firstOpenedAt",
      "lastOpenedAt",
      "openCount",
    ])
    expect(JSON.stringify(where)).toContain("pixel")
    expect(await trackedLinkService.recordOpen("bad", now)).toBeUndefined()
    expect(buildTrackedPixelUrl("https://hub.x/", token)).toBe(
      `https://hub.x/go/${token}/o`,
    )
  })
})
