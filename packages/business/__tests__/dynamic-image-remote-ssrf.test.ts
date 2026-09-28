import { afterEach, describe, expect, test, vi } from "vitest"
import { loadRemoteImage } from "../src/dynamic-image/render"

// s215 (Codex, pre-existing): the render's image loader fetched any URL and
// followed every redirect from inside the hub network. It now goes through
// the SSRF guard, per hop.
afterEach(() => {
  vi.unstubAllGlobals()
})

describe("dynamic image remote loader (s215)", () => {
  test.each([
    "http://127.0.0.1:3000/api/health",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/x.png",
  ])("never fetches %s", async (url) => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    await expect(loadRemoteImage(url)).rejects.toMatchObject({
      name: "SsrfFetchError",
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("a public image URL that redirects to cloud metadata is refused at the hop", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.redirect("http://169.254.169.254/latest/meta-data/", 302),
      )
    vi.stubGlobal("fetch", fetchMock)
    await expect(
      loadRemoteImage("http://93.184.216.34/logo.png"),
    ).rejects.toMatchObject({ reason: "unsafeRedirect" })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
