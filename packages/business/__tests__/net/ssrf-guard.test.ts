import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const { assertPublicUrl, checkSsrfSafety, isBlockedIp, isSsrfUnsafeUrl } =
  await import("../../src/net/ssrf-guard")

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

// s229a: IPv6 is judged on its value, not one spelling of it. Every
// "allowed" row below passed the old prefix test.
describe("isBlockedIp IPv6", () => {
  test.each([
    "::1",
    "0:0:0:0:0:0:0:1",
    "0000:0000:0000:0000:0000:0000:0000:0001",
    "::0001",
    "::",
    "::127.0.0.1",
    "::7f00:1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "0000:0000:0000:0000:0000:ffff:7f00:0001",
    "::FFFF:A9FE:A9FE",
    "::ffff:0:10.0.0.1",
    "64:ff9b::7f00:1",
    "64:ff9b::169.254.169.254",
    "64:ff9b:1::1",
    "2002:7f00:1::",
    "2002:a9fe:a9fe::1",
    "2002:c0a8:101::1",
    "fe80::1",
    "fe90::1",
    "febf:ffff::1",
    "fec0::1",
    "feff::1",
    "fc00::1",
    "fdff:ffff::1",
    "ff02::1",
    "FF05::2",
    "100::1",
    "2001::1",
    "2001:db8::1",
    "3fff::1",
    "5f00::1",
    "fe80::1%eth0",
    "[::1]",
    "::1::",
    "1:2:3:4:5:6:7:8:9",
    "",
  ])("blocks %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(true)
  })

  test.each([
    "2606:4700:4700::1111",
    "2a0a:4cc0:101:ca5:54c6:aff:fe6c:6548",
    "2A0A:4CC0:0101:0CA5::1",
    "fc::1",
    "::ffff:8.8.8.8",
    "::ffff:808:808",
    "64:ff9b::8.8.8.8",
    "2002:808:808::1",
    "2001:200::1",
  ])("allows public %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(false)
  })

  test("an IPv4 carried in any IPv6 form gets the IPv4 verdict", () => {
    const hex = (n: number) => n.toString(16)
    // A fixed-seed LCG: a failure reproduces from the CI log.
    let seed = 229
    const nextOctet = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed % 256
    }
    for (let i = 0; i < 2000; i++) {
      const octets = Array.from({ length: 4 }, nextOctet)
      const v4 = octets.join(".")
      const hi = hex((octets[0] ?? 0) * 256 + (octets[1] ?? 0))
      const lo = hex((octets[2] ?? 0) * 256 + (octets[3] ?? 0))
      const expected = isBlockedIp(v4)
      for (const form of [
        `::ffff:${v4}`,
        `::ffff:${hi}:${lo}`,
        `0:0:0:0:0:ffff:${hi}:${lo}`,
        `64:ff9b::${v4}`,
        `2002:${hi}:${lo}::1`,
      ]) {
        expect([form, isBlockedIp(form)]).toEqual([form, expected])
      }
    }
  })
})
