import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const { assertPublicUrl, checkSsrfSafety, isSsrfUnsafeUrl } = await import(
  "../../src/net/ssrf-guard"
)

const dohJsonResponse = (records: { type: number; data: string }[]) =>
  new Response(JSON.stringify({ Answer: records }), {
    status: 200,
    headers: { "content-type": "application/dns-json" },
  })

const A_RECORD = 1

// The guard asks for A and AAAA separately (s215): answer the A query with
// `ip`, the AAAA query with nothing, and a fresh Response each time.
const aOnly = (ip: string) => (input: URL | string) =>
  Promise.resolve(
    new URL(String(input)).searchParams.get("type") === "A"
      ? dohJsonResponse([{ type: A_RECORD, data: ip }])
      : dohJsonResponse([]),
  )
const IMAGE_URL_CONTEXT_PATTERN = /image URL/

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("isSsrfUnsafeUrl", () => {
  test("rejects non-http(s) schemes", async () => {
    expect(await isSsrfUnsafeUrl("ftp://example.com")).toBe(true)
    expect(await isSsrfUnsafeUrl("file:///etc/passwd")).toBe(true)
    expect(await isSsrfUnsafeUrl("not a url")).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("rejects localhost", async () => {
    expect(await isSsrfUnsafeUrl("http://localhost/")).toBe(true)
    expect(await isSsrfUnsafeUrl("http://localhost:8080/")).toBe(true)
  })

  test("rejects loopback and cloud metadata IPs directly", async () => {
    expect(await isSsrfUnsafeUrl("http://127.0.0.1/")).toBe(true)
    expect(
      await isSsrfUnsafeUrl("http://169.254.169.254/latest/meta-data"),
    ).toBe(true)
    expect(await isSsrfUnsafeUrl("http://[::1]/")).toBe(true)
  })

  test("rejects private IPv4 ranges directly", async () => {
    expect(await isSsrfUnsafeUrl("http://10.0.0.5/")).toBe(true)
    expect(await isSsrfUnsafeUrl("http://172.16.0.5/")).toBe(true)
    expect(await isSsrfUnsafeUrl("http://192.168.1.1/")).toBe(true)
  })

  test("rejects a hostname that resolves to a private IP (DNS rebinding)", async () => {
    fetchMock.mockResolvedValue(
      dohJsonResponse([{ type: A_RECORD, data: "169.254.169.254" }]),
    )
    expect(await isSsrfUnsafeUrl("http://attacker.example.com/")).toBe(true)
  })

  test("rejects when DNS resolution fails", async () => {
    fetchMock.mockRejectedValue(new Error("network error"))
    expect(await isSsrfUnsafeUrl("http://does-not-resolve.example.com/")).toBe(
      true,
    )
  })

  test("rejects when the DoH response is not ok", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 500 }))
    expect(await isSsrfUnsafeUrl("http://does-not-resolve.example.com/")).toBe(
      true,
    )
  })

  test("rejects when DNS returns no records", async () => {
    fetchMock.mockResolvedValue(dohJsonResponse([]))
    expect(await isSsrfUnsafeUrl("http://no-records.example.com/")).toBe(true)
  })

  test("allows a public IP resolved via DNS", async () => {
    fetchMock.mockImplementation(aOnly("93.184.216.34"))
    expect(await isSsrfUnsafeUrl("https://public.example.com/")).toBe(false)
  })

  test("allows a public IP passed directly", async () => {
    expect(await isSsrfUnsafeUrl("https://93.184.216.34/")).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("respects private range boundaries precisely", async () => {
    // 172.16.0.0/12 spans 172.16.0.0 - 172.31.255.255
    expect(await isSsrfUnsafeUrl("http://172.15.255.255/")).toBe(false)
    expect(await isSsrfUnsafeUrl("http://172.31.255.255/")).toBe(true)
    expect(await isSsrfUnsafeUrl("http://172.32.0.0/")).toBe(false)
  })

  test("rejects IPv4-mapped IPv6 literals for loopback and private ranges", async () => {
    // Node's URL parser canonicalizes these to hex form (e.g. "::ffff:7f00:1")
    // before the guard ever sees them — regression test for the bypass where
    // the guard only matched the un-normalized dotted-quad string form.
    expect(await isSsrfUnsafeUrl("http://[::ffff:127.0.0.1]/")).toBe(true)
    expect(await isSsrfUnsafeUrl("http://[::ffff:10.0.0.1]/")).toBe(true)
    expect(await isSsrfUnsafeUrl("http://[::ffff:169.254.169.254]/")).toBe(true)
  })

  test("allows an IPv4-mapped IPv6 literal for a public address", async () => {
    expect(await isSsrfUnsafeUrl("http://[::ffff:93.184.216.34]/")).toBe(false)
  })
})

describe("checkSsrfSafety", () => {
  test("returns the resolved IPs alongside a safe verdict", async () => {
    fetchMock.mockImplementation(aOnly("93.184.216.34"))
    const result = await checkSsrfSafety("https://public.example.com/")
    expect(result).toEqual({ unsafe: false, resolvedIps: ["93.184.216.34"] })
  })

  test("returns the literal IP when the URL already contains one", async () => {
    const result = await checkSsrfSafety("https://93.184.216.34/")
    expect(result).toEqual({ unsafe: false, resolvedIps: ["93.184.216.34"] })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("assertPublicUrl", () => {
  test("resolves without throwing for a public URL", async () => {
    await expect(
      assertPublicUrl("https://93.184.216.34/"),
    ).resolves.toBeUndefined()
  })

  test("throws with the given context for a blocked URL", async () => {
    await expect(
      assertPublicUrl("http://127.0.0.1/", "image URL"),
    ).rejects.toThrow(IMAGE_URL_CONTEXT_PATTERN)
  })
})

describe("checkSsrfSafety queries A and AAAA (s215)", () => {
  const byType = (a: string[], aaaa: string[]) =>
    vi.fn((input: URL | string) => {
      const type = new URL(String(input)).searchParams.get("type")
      const data = type === "AAAA" ? aaaa : a
      return Promise.resolve(
        Response.json({
          Answer: data.map((ip) => ({
            type: type === "AAAA" ? 28 : 1,
            data: ip,
          })),
        }),
      )
    })

  test("a public A with a private AAAA is unsafe", async () => {
    vi.stubGlobal("fetch", byType(["93.184.216.34"], ["fd00::1"]))
    expect(await isSsrfUnsafeUrl("https://dual.example.com/")).toBe(true)
  })

  test("a public A with no AAAA stays safe", async () => {
    const fetchMock = byType(["93.184.216.34"], [])
    vi.stubGlobal("fetch", fetchMock)
    expect(await isSsrfUnsafeUrl("https://v4.example.com/")).toBe(false)
    const types = fetchMock.mock.calls.map(([u]) =>
      new URL(String(u)).searchParams.get("type"),
    )
    expect(types.sort()).toEqual(["A", "AAAA"])
  })
})
