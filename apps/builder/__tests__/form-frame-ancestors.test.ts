// @vitest-environment node

import { describe, expect, test, vi } from "vitest"

vi.mock("@chatbotx.io/redis", () => ({ distributedStore: {} }))
vi.mock("@chatbotx.io/business/form", () => ({ formService: {} }))
vi.mock("@/lib/log", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}))

const { formFrameAncestors, buildFrameAncestors } = await import(
  "../src/lib/forms/frame-ancestors"
)
type FrameAncestorsCache =
  import("../src/lib/forms/frame-ancestors").FrameAncestorsCache

const cache = () => {
  const map = new Map<string, unknown>()
  const puts: [string, unknown, number | undefined][] = []
  const store: FrameAncestorsCache & {
    map: Map<string, unknown>
    puts: typeof puts
  } = {
    map,
    puts,
    get: <T>(k: string) =>
      Promise.resolve((map.get(k) as T | undefined) ?? null),
    put: (k: string, v: unknown, ttl?: number) => {
      map.set(k, v)
      puts.push([k, v, ttl])
      return Promise.resolve()
    },
  }
  return store
}

describe("public form frame-ancestors (s200)", () => {
  test("only /forms/<ws>/<slug> paths get a policy", async () => {
    const load = vi.fn(() => Promise.resolve(["https://a.example"]))
    for (const p of [
      "/forms",
      "/forms/1",
      "/forms/1/Bad Slug",
      "/f/abc",
      "/space/1/forms/2/edit",
    ]) {
      expect(
        await formFrameAncestors(p, { load, cache: cache() }),
        p,
      ).toBeNull()
    }
    expect(load).not.toHaveBeenCalled()
  })

  test("no origins -> 'self' only; origins listed verbatim; unknown form -> 'self'", async () => {
    expect(
      await formFrameAncestors("/forms/11701868563365888/demo", {
        load: () => Promise.resolve([]),
        cache: cache(),
      }),
    ).toBe("frame-ancestors 'self'")
    expect(
      await formFrameAncestors("/forms/11701868563365888/demo", {
        load: () =>
          Promise.resolve(["https://a.example", "https://b.example:8443"]),
        cache: cache(),
      }),
    ).toBe("frame-ancestors 'self' https://a.example https://b.example:8443")
    expect(
      await formFrameAncestors("/forms/11701868563365888/nope", {
        load: () => Promise.resolve(null),
        cache: cache(),
      }),
    ).toBe("frame-ancestors 'self'")
    expect(buildFrameAncestors([])).toBe("frame-ancestors 'self'")
  })

  test("the allowlist is cached for 60 s and a cache failure never blocks", async () => {
    const c = cache()
    const load = vi.fn(() => Promise.resolve(["https://a.example"]))
    await formFrameAncestors("/forms/11701868563365888/demo", {
      load,
      cache: c,
    })
    await formFrameAncestors("/forms/11701868563365888/demo", {
      load,
      cache: c,
    })
    expect(load).toHaveBeenCalledTimes(1)
    expect(c.puts).toEqual([[expect.any(String), ["https://a.example"], 60]])
    const broken: FrameAncestorsCache = {
      get: () => Promise.reject(new Error("down")),
      put: () => Promise.reject(new Error("down")),
    }
    expect(
      await formFrameAncestors("/forms/11701868563365888/demo", {
        load,
        cache: broken,
      }),
    ).toBe("frame-ancestors 'self' https://a.example")
  })

  test("a load failure fails closed to 'self'", async () => {
    expect(
      await formFrameAncestors("/forms/11701868563365888/demo", {
        load: () => Promise.reject(new Error("db down")),
        cache: cache(),
      }),
    ).toBe("frame-ancestors 'self'")
  })
})

describe("origin lists are re-validated wherever they come from (probe, s200)", () => {
  test("a poisoned cache or an odd load result never reaches the header", async () => {
    const poisoned = cache()
    poisoned.map.set("form-frame-ancestors:11701868563365888:demo", [
      "*",
      "'none'",
      "https://a.example; script-src *",
      "https://ok.example",
      1,
      "https://x.example\nX-Foo: bar",
    ])
    expect(
      await formFrameAncestors("/forms/11701868563365888/demo", {
        load: () => Promise.resolve([]),
        cache: poisoned,
      }),
    ).toBe("frame-ancestors 'self' https://ok.example")
    const stringCached = cache()
    stringCached.map.set(
      "form-frame-ancestors:11701868563365888/demo",
      "https://a.example",
    )
    expect(
      await formFrameAncestors("/forms/11701868563365888/demo", {
        load: () => Promise.resolve("https://b.example" as unknown as string[]),
        cache: stringCached,
      }),
    ).toBe("frame-ancestors 'self'")
    expect(buildFrameAncestors("x")).toBe("frame-ancestors 'self'")
    expect(
      buildFrameAncestors(["https://a.example", "javascript:alert(1)"]),
    ).toBe("frame-ancestors 'self' https://a.example")
  })
})
