import { afterEach, describe, expect, test, vi } from "vitest"
import {
  fetchFollowingSafeRedirects,
  fetchPublicUrl,
  SsrfFetchError,
} from "../src/net/safe-fetch"

// The real guard: every URL here is an IP literal (or has no host), so no
// DNS-over-HTTPS lookup runs. 93.184.216.34 is a public address.
const PUBLIC = "http://93.184.216.34/img.png"

const redirectTo = (location: string, status = 302) =>
  new Response(null, { status, headers: { location } })

afterEach(() => {
  vi.unstubAllGlobals()
})

const stubFetch = (...responses: Response[]) => {
  const fetchMock = vi.fn()
  for (const response of responses) {
    fetchMock.mockResolvedValueOnce(response)
  }
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

describe("fetchPublicUrl (s215)", () => {
  test.each([
    "http://127.0.0.1/x",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/x",
    "http://[::ffff:127.0.0.1]/x",
    "http://10.0.0.5/x",
    "http://localhost/x",
    "file:///etc/passwd",
    "ftp://93.184.216.34/x",
    "not a url",
  ])("refuses %s before any fetch", async (url) => {
    const fetchMock = stubFetch()
    await expect(fetchPublicUrl(url)).rejects.toMatchObject({
      name: "SsrfFetchError",
      reason: "unsafeUrl",
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("fetches a public URL with redirect: manual", async () => {
    const fetchMock = stubFetch(new Response("png", { status: 200 }))
    const response = await fetchPublicUrl(PUBLIC)
    expect(await response.text()).toBe("png")
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" })
  })

  test.each([
    ["loopback", "http://127.0.0.1:3000/admin"],
    ["cloud metadata", "http://169.254.169.254/latest/meta-data/"],
    ["IPv6 loopback", "http://[::1]/"],
    ["IPv4-mapped loopback", "http://[::ffff:127.0.0.1]/"],
    ["a non-http scheme", "file:///etc/passwd"],
  ])("refuses a redirect to %s and never fetches it", async (_, target) => {
    const fetchMock = stubFetch(redirectTo(target, 307))
    const error = await fetchPublicUrl(PUBLIC).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SsrfFetchError)
    expect((error as SsrfFetchError).reason).toBe("unsafeRedirect")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test("a relative Location resolves against the hop and is re-checked", async () => {
    const fetchMock = stubFetch(
      redirectTo("/next.png", 308),
      new Response("ok", { status: 200 }),
    )
    await fetchPublicUrl(PUBLIC)
    expect(fetchMock.mock.calls[1]?.[0]).toBe("http://93.184.216.34/next.png")
  })

  test("a safe hop, then an unsafe one: refused at the second", async () => {
    const fetchMock = stubFetch(
      redirectTo("http://93.184.216.35/b.png"),
      redirectTo("http://127.0.0.1/c.png"),
    )
    await expect(fetchPublicUrl(PUBLIC)).rejects.toMatchObject({
      reason: "unsafeRedirect",
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test("a redirect with no Location is refused", async () => {
    stubFetch(new Response(null, { status: 302 }))
    await expect(fetchPublicUrl(PUBLIC)).rejects.toMatchObject({
      reason: "unsafeRedirect",
    })
  })

  test("the hop cap fires past maxRedirects", async () => {
    const loop = () => redirectTo(PUBLIC)
    const fetchMock = stubFetch(loop(), loop(), loop(), loop())
    await expect(fetchPublicUrl(PUBLIC, {}, 2)).rejects.toMatchObject({
      reason: "tooManyRedirects",
    })
    // The first fetch plus two followed hops; the third redirect is refused.
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  test("non-redirect error statuses come back to the caller unchanged", async () => {
    stubFetch(new Response("nope", { status: 404 }))
    const response = await fetchPublicUrl(PUBLIC)
    expect(response.status).toBe(404)
  })

  test("fetchFollowingSafeRedirects keeps the caller's init but forces manual redirects", async () => {
    const fetchMock = stubFetch(new Response("ok", { status: 200 }))
    await fetchFollowingSafeRedirects(PUBLIC, {
      method: "POST",
      redirect: "follow",
    })
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      redirect: "manual",
    })
  })
})
