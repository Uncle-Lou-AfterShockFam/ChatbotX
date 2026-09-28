import ky from "ky"
import { afterEach, describe, expect, test } from "vitest"
import {
  isSsrfFetchError,
  kyOutboundFetch,
  OutboundFetchNotInstalledError,
  type OutboundRequestInit,
  outboundFetch,
  readCapped,
  registerOutboundFetch,
  SsrfFetchError,
  uninstallOutboundFetch,
} from "../src/outbound-fetch"

type Call = { url: string; init?: OutboundRequestInit }

const record = (answer = () => new Response("ok")) => {
  const calls: Call[] = []
  registerOutboundFetch(async (input, init) => {
    calls.push({ url: String(input), init })
    return await answer()
  })
  return calls
}

afterEach(uninstallOutboundFetch)

describe("registry", () => {
  test("uninstalled fails closed", async () => {
    await expect(outboundFetch("https://example.com")).rejects.toBeInstanceOf(
      OutboundFetchNotInstalledError,
    )
  })

  test("the registry is the globalThis Symbol.for key business installs", () => {
    const calls = record()
    const registered = (globalThis as Record<symbol, unknown>)[
      Symbol.for("chatbotx.outboundFetch")
    ]
    expect(typeof registered).toBe("function")
    expect(calls).toEqual([])
  })

  test("SsrfFetchError carries its reason", () => {
    const error = new SsrfFetchError("unsafeAddress", "http://10.0.0.1")
    expect(error.reason).toBe("unsafeAddress")
    expect(error.name).toBe("SsrfFetchError")
  })
})

describe("kyOutboundFetch", () => {
  test("a ky POST reaches the registry with url, method, headers and body", async () => {
    const calls = record(() => Response.json({ ok: true }))
    const client = ky.create({
      baseUrl: "https://api.example.com",
      fetch: kyOutboundFetch,
      retry: 0,
      headers: { "Api-Token": "k" },
    })

    await client.post("v1/things", { json: { a: 1 } }).json()

    expect(calls).toHaveLength(1)
    const [call] = calls
    expect(call?.url).toBe("https://api.example.com/v1/things")
    expect(call?.init?.method).toBe("POST")
    expect(new Headers(call?.init?.headers).get("api-token")).toBe("k")
    expect(new TextDecoder().decode(call?.init?.body as Uint8Array)).toBe(
      '{"a":1}',
    )
  })

  test("a GET sends no body", async () => {
    const calls = record()
    await ky("https://api.example.com/x", { fetch: kyOutboundFetch, retry: 0 })
    expect(calls[0]?.init?.method).toBe("GET")
    expect(calls[0]?.init?.body).toBeNull()
  })

  test("a refusal propagates as SsrfFetchError, not retried", async () => {
    let attempts = 0
    registerOutboundFetch((input) => {
      attempts += 1
      return Promise.reject(new SsrfFetchError("unsafeAddress", String(input)))
    })

    await expect(
      ky("http://169.254.169.254/latest", { fetch: kyOutboundFetch, retry: 0 }),
    ).rejects.toBeInstanceOf(SsrfFetchError)
    expect(attempts).toBe(1)
  })

  test("uninstalled, a ky client fails closed", async () => {
    await expect(
      ky("https://api.example.com/x", { fetch: kyOutboundFetch, retry: 0 }),
    ).rejects.toBeInstanceOf(OutboundFetchNotInstalledError)
  })

  test("a plain URL string is passed through", async () => {
    const calls = record()
    await kyOutboundFetch("https://api.example.com/y", { method: "DELETE" })
    expect(calls[0]).toMatchObject({
      url: "https://api.example.com/y",
      init: { method: "DELETE" },
    })
  })

  test.each([
    null,
    undefined,
    42,
    {},
  ])("rejects a non-Request input %s", async (bad) => {
    record()
    await expect(
      kyOutboundFetch(bad as unknown as Request),
    ).rejects.toBeInstanceOf(TypeError)
  })

  test("a Request's redirect mode is carried over", async () => {
    const calls = record()
    await kyOutboundFetch(
      new Request("https://api.example.com/z", { redirect: "manual" }),
    )
    expect(calls[0]?.init?.redirect).toBe("manual")
  })
})

describe("readCapped", () => {
  const streamOf = (sizes: number[]) => {
    let i = 0
    let pulled = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const size = sizes[i]
        i += 1
        if (size === undefined) {
          controller.close()
          return
        }
        pulled += 1
        controller.enqueue(new Uint8Array(size))
      },
    })
    return { stream, pulled: () => pulled }
  }

  test("returns the whole body at or under the cap", async () => {
    const { stream } = streamOf([3, 3])
    const bytes = await readCapped(new Response(stream), 6)
    expect(bytes?.byteLength).toBe(6)
  })

  test("returns null and stops pulling once past the cap", async () => {
    const { stream, pulled } = streamOf([4, 4, 4, 4, 4])
    expect(await readCapped(new Response(stream), 6)).toBeNull()
    expect(pulled()).toBeLessThan(5)
  })

  test("an empty body is zero bytes", async () => {
    expect((await readCapped(new Response(null), 1))?.byteLength).toBe(0)
  })
})

describe("isSsrfFetchError (s219: a refusal crosses Next module layers)", () => {
  // What a second module layer holds: the same class, another identity.
  class ForeignSsrfFetchError extends Error {
    readonly reason: string
    constructor(reason: string) {
      super(`[ssrf-guard] ${reason}: http://10.0.0.1`)
      this.name = "SsrfFetchError"
      this.reason = reason
    }
  }

  test("recognises this layer's class and a foreign copy", () => {
    expect(isSsrfFetchError(new SsrfFetchError("unsafeUrl", "x"))).toBe(true)
    const foreign = new ForeignSsrfFetchError("unsafeAddress")
    expect(foreign instanceof SsrfFetchError).toBe(false)
    expect(isSsrfFetchError(foreign)).toBe(true)
  })

  test.each([
    ["an unknown reason", new ForeignSsrfFetchError("somethingElse")],
    [
      "the name without a reason",
      Object.assign(new Error("x"), { name: "SsrfFetchError" }),
    ],
    ["another error", new TypeError("fetch failed")],
    ["a plain object", { name: "SsrfFetchError", reason: "unsafeUrl" }],
    ["null", null],
    ["undefined", undefined],
    ["a string", "SsrfFetchError"],
  ])("rejects %s", (_label, value) => {
    expect(isSsrfFetchError(value)).toBe(false)
  })
})
