// @vitest-environment node

import { describe, expect, test, vi } from "vitest"

vi.mock("@chatbotx.io/redis", () => ({ distributedStore: {} }))
vi.mock("@chatbotx.io/business", () => ({ integrationWebchatService: {} }))
vi.mock("@/lib/log", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}))

const { webchatFrameAncestors, webchatAncestorSources } = await import(
  "../src/features/integration-webchat/lib/frame-ancestors"
)
const { isFirstPartyOrigin, isGuestOriginAllowed } = await import(
  "../src/features/integration-webchat/lib/authorized-domain"
)
type FrameAncestorsCache =
  import("../src/lib/forms/frame-ancestors").FrameAncestorsCache

const cache = () => {
  const map = new Map<string, unknown>()
  const puts: [string, unknown, number | undefined][] = []
  const store: FrameAncestorsCache = {
    get: <T>(key: string) => Promise.resolve((map.get(key) as T) ?? null),
    put: (key, value, ttl) => {
      puts.push([key, value, ttl])
      map.set(key, value)
      return Promise.resolve()
    },
  }
  return { store, map, puts }
}

const params = (workspaceId = "11701868563365888", webchatId = "42") =>
  new URLSearchParams({ workspaceId, webchatId })
const SELF_ONLY = "frame-ancestors 'self'"

describe("webchatFrameAncestors", () => {
  test("only answers for the /webchat page", async () => {
    const load = vi.fn()
    expect(
      await webchatFrameAncestors("/webchatx", params(), { load }),
    ).toBeNull()
    expect(
      await webchatFrameAncestors("/webchat/extra", params(), { load }),
    ).toBeNull()
    expect(load).not.toHaveBeenCalled()
  })

  test("an allowlist becomes host + subdomain sources on both schemes and any port", async () => {
    const { store, puts } = cache()
    const csp = await webchatFrameAncestors("/webchat", params(), {
      cache: store,
      load: async () => ["Shop.Example.com", "https://blog.example.org:8443/x"],
    })
    expect(csp).toBe(
      `${SELF_ONLY} https://shop.example.com:* https://*.shop.example.com:* http://shop.example.com:* http://*.shop.example.com:* https://blog.example.org:* https://*.blog.example.org:* http://blog.example.org:* http://*.blog.example.org:*`,
    )
    expect(puts).toHaveLength(1)
    expect(puts[0]?.[2]).toBe(60)
  })

  test("an empty allowlist is 'self' only (no cross-site embed)", async () => {
    expect(
      await webchatFrameAncestors("/webchat/", params(), {
        cache: cache().store,
        load: async () => [],
      }),
    ).toBe(SELF_ONLY)
  })

  test.each([
    ["missing ids", new URLSearchParams()],
    ["non-numeric workspace", params("ws-1", "42")],
    ["overlong id", params("1".repeat(20), "42")],
  ])("%s: 'self' only without a lookup", async (_, search) => {
    const load = vi.fn()
    expect(await webchatFrameAncestors("/webchat", search, { load })).toBe(
      SELF_ONLY,
    )
    expect(load).not.toHaveBeenCalled()
  })

  test("a load failure fails closed and is not cached", async () => {
    const { store, puts } = cache()
    const csp = await webchatFrameAncestors("/webchat", params(), {
      cache: store,
      load: () => Promise.reject(new Error("db down")),
    })
    expect(csp).toBe(SELF_ONLY)
    expect(puts).toHaveLength(0)
  })

  test("a cache hit skips the load; a broken cache still loads", async () => {
    const { store, map } = cache()
    map.set("webchat-frame-ancestors:11701868563365888:42", ["a.example"])
    const load = vi.fn(async () => ["b.example"])
    expect(
      await webchatFrameAncestors("/webchat", params(), { cache: store, load }),
    ).toContain("https://a.example:* ")
    expect(load).not.toHaveBeenCalled()

    const broken: FrameAncestorsCache = {
      get: () => Promise.reject(new Error("redis down")),
      put: () => Promise.reject(new Error("redis down")),
    }
    expect(
      await webchatFrameAncestors("/webchat", params(), {
        cache: broken,
        load,
      }),
    ).toContain("https://b.example:* ")
  })

  test("a poisoned cache or stored value can never inject a directive", async () => {
    const { store, map } = cache()
    map.set("webchat-frame-ancestors:11701868563365888:42", [
      "evil.example; script-src *",
      "'unsafe-inline'",
      "*",
      "*.wild.example",
      "a b.example",
      42,
      null,
    ])
    const csp = await webchatFrameAncestors("/webchat", params(), {
      cache: store,
    })
    expect(csp).not.toContain(";")
    expect(csp).not.toContain("script-src")
    expect(csp).not.toContain("unsafe")
    expect(
      csp?.split(" ").every((part) => !part.includes("'") || part === "'self'"),
    ).toBe(true)
  })
})

describe("webchatAncestorSources", () => {
  test("non-arrays and junk give no sources; duplicates collapse; the list is capped", () => {
    expect(webchatAncestorSources(null)).toEqual([])
    expect(webchatAncestorSources("a.example")).toEqual([])
    expect(webchatAncestorSources(["a.example", "A.EXAMPLE."])).toHaveLength(4)
    const many = Array.from({ length: 500 }, (_, i) => `h${i}.example`)
    expect(webchatAncestorSources(many)).toHaveLength(200)
  })
})

describe("guest origin gate (s210 owner decision)", () => {
  const HUB = "app.chatbotx.io"
  test.each([
    // origin, allowlist, appHost, allowed
    [null, ["shop.example"], HUB, true],
    [HUB, ["shop.example"], HUB, true],
    ["APP.chatbotx.io", ["shop.example"], HUB, true],
    ["https://app.chatbotx.io", ["shop.example"], HUB, true],
    [HUB, ["shop.example"], "", false],
    ["evil.example", ["shop.example"], HUB, false],
    ["app.chatbotx.io.evil.example", ["shop.example"], HUB, false],
    ["x.shop.example", ["shop.example"], HUB, true],
    ["evil.example", [], HUB, true],
  ] as const)("%s with %j on %s -> %s", (origin, list, appHost, allowed) => {
    expect(isGuestOriginAllowed(origin, [...list], appHost)).toBe(allowed)
  })

  test("isFirstPartyOrigin: an empty proxy host never matches", () => {
    expect(isFirstPartyOrigin("", "")).toBe(true)
    expect(isFirstPartyOrigin("app.chatbotx.io", "")).toBe(false)
  })
})
