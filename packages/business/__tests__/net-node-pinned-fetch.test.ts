// @vitest-environment node

import http from "node:http"
import type { AddressInfo } from "node:net"
import { gzipSync } from "node:zlib"
import { server as msw } from "@chatbotx.io/vitest-config/msw"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"
import { SsrfFetchError } from "../src/net/safe-fetch"
import { isBlockedIp } from "../src/net/ssrf-guard"
import { pinnedFetch } from "../src/net-node/pinned-fetch"

// s216: the SSRF check bound to the connection for every non-image caller. A
// real local server stands in for the internet; a test resolver maps names to
// it, and `isBlocked` lets its 127.0.0.1 count as "public" only where a test
// needs a reachable target.
type Hit = { path: string; method: string; body: string; auth?: string }
let server: http.Server
let port = 0
let hits: Hit[] = []

const route = (req: http.IncomingMessage, res: http.ServerResponse) => {
  const path = req.url ?? ""
  const redirects: Record<string, [number, string | undefined]> = {
    "/hop": [307, "/ok"],
    "/post-307": [307, "/echo"],
    "/post-303": [303, "/echo"],
    "/post-302": [302, "/echo"],
    "/to-private-literal": [302, "http://10.9.9.9/x"],
    "/to-loopback-literal": [302, "http://127.0.0.2:1/x"],
    "/to-private-name": [302, `http://evil.test:${port}/ok`],
    "/to-other-origin": [302, `http://other.test:${port}/echo`],
    "/to-file": [302, "file:///etc/passwd"],
    "/loop": [302, "/loop"],
    "/no-location": [302, undefined],
  }
  const redirect = redirects[path]
  if (redirect) {
    const [status, location] = redirect
    res.writeHead(status, location ? { location } : {})
    res.end()
  } else if (path === "/ok") {
    res.writeHead(200, { "content-type": "text/plain" })
    res.end("OK")
  } else if (path === "/echo") {
    res.writeHead(200)
    res.end(`${req.method}`)
  } else if (path === "/gzip") {
    res.writeHead(200, { "content-encoding": "gzip" })
    res.end(gzipSync(Buffer.from("UNZIPPED")))
  } else if (path === "/no-content") {
    res.writeHead(204)
    res.end()
  } else if (path === "/reset-mid-body") {
    res.writeHead(200, { "content-length": "4096" })
    res.write(Buffer.alloc(512, 1))
    setTimeout(() => req.socket.destroy(), 20)
  } else if (path === "/stall") {
    res.writeHead(200, { "content-length": "4096" })
    res.write(Buffer.alloc(512, 1))
  } else if (path === "/host") {
    res.writeHead(200)
    res.end(req.headers.host)
  } else if (path === "/slow-hop") {
    setTimeout(() => {
      res.writeHead(302, { location: "/slow-hop" })
      res.end()
    }, 120)
  } else {
    res.writeHead(404)
    res.end()
  }
}

beforeAll(async () => {
  // MSW patches node:http for the whole package; this file talks to a real
  // local server (the pinned `lookup` is the thing under test), so it steps
  // out and puts it back for the shared teardown.
  msw.close()
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => {
      hits.push({
        path: req.url ?? "",
        method: req.method ?? "",
        body: Buffer.concat(chunks).toString(),
        auth: req.headers.authorization,
      })
      route(req, res)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  msw.listen({ onUnhandledRequest: "error" })
})

beforeEach(() => {
  hits = []
})

// site.test and other.test -> the local server; evil.test -> 10/8.
const resolver = (hostname: string) => {
  if (hostname === "site.test" || hostname === "other.test") {
    return Promise.resolve([{ address: "127.0.0.1", family: 4 }])
  }
  if (hostname === "evil.test") {
    return Promise.resolve([{ address: "10.9.9.9", family: 4 }])
  }
  return Promise.reject(new Error(`ENOTFOUND ${hostname}`))
}
// Everything the real guard blocks, except the local server's loopback.
const isBlocked = (ip: string) => ip !== "127.0.0.1" && isBlockedIp(ip)
const opts = { resolver, isBlocked }
const at = (path: string, host = "site.test") => `http://${host}:${port}${path}`

const refusal = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(SsrfFetchError)
  return (error as SsrfFetchError).reason
}

describe("pinnedFetch (s216)", () => {
  test("a public named host answers with a global Response", async () => {
    const response = await pinnedFetch(at("/ok"), {}, opts)
    expect(response).toBeInstanceOf(Response)
    expect(response.status).toBe(200)
    expect(response.url).toBe(at("/ok"))
    expect(response.headers.get("content-type")).toBe("text/plain")
    expect(await response.text()).toBe("OK")
  })

  test("DNS rebinding: a name a prior check saw as public is refused when it answers private at connect", async () => {
    // Stands in for DoH-then-fetch: the first answer (the "check") is public,
    // the connect-time answer is private. Only the connect-time one counts.
    let calls = 0
    const rebinding = (hostname: string) => {
      calls += 1
      return calls === 1
        ? resolver(hostname)
        : Promise.resolve([{ address: "169.254.169.254", family: 4 }])
    }
    expect(await rebinding("site.test")).toEqual([
      { address: "127.0.0.1", family: 4 },
    ])
    expect(
      await refusal(
        pinnedFetch(at("/ok"), {}, { resolver: rebinding, isBlocked }),
      ),
    ).toBe("unsafeAddress")
    expect(hits).toEqual([])
  })

  test("a name with one private address among public ones is refused", async () => {
    const mixed = () =>
      Promise.resolve([
        { address: "127.0.0.1", family: 4 },
        { address: "fd00::1", family: 6 },
      ])
    expect(
      await refusal(pinnedFetch(at("/ok"), {}, { resolver: mixed, isBlocked })),
    ).toBe("unsafeAddress")
    expect(hits).toEqual([])
  })

  test("the default guard refuses localhost and loopback with no seams", async () => {
    expect(await refusal(pinnedFetch(`http://localhost:${port}/ok`))).toBe(
      "unsafeAddress",
    )
    for (const url of [
      `http://127.0.0.1:${port}/ok`,
      `http://2130706433:${port}/ok`,
    ]) {
      expect(await refusal(pinnedFetch(url))).toBe("unsafeUrl")
    }
    expect(hits).toEqual([])
  })

  test.each([
    "http://10.9.9.9/x",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/x",
    "http://[::ffff:127.0.0.1]/x",
    "http://2130706434/x", // 127.0.0.2 (the seam only allows .1)
    "http://0x7f.2/x",
    "file:///etc/passwd",
    "ftp://site.test/x",
    "not a url",
  ])("refuses %s before dialling", async (url) => {
    expect(await refusal(pinnedFetch(url, {}, opts))).toBe("unsafeUrl")
    expect(hits).toEqual([])
  })

  test("follows a checked redirect", async () => {
    const response = await pinnedFetch(at("/hop"), {}, opts)
    expect(await response.text()).toBe("OK")
    expect(response.url).toBe(at("/ok"))
  })

  test.each([
    ["/to-private-literal", "unsafeRedirect"],
    ["/to-loopback-literal", "unsafeRedirect"],
    ["/to-private-name", "unsafeAddress"],
    ["/to-file", "unsafeRedirect"],
    ["/no-location", "unsafeRedirect"],
    ["/loop", "tooManyRedirects"],
  ])("refuses the redirect %s (%s)", async (path, reason) => {
    expect(await refusal(pinnedFetch(at(path), {}, opts))).toBe(reason)
    expect(hits.filter((h) => h.path === "/ok")).toEqual([])
  })

  test("the hop cap counts hops: maxRedirects 0 refuses the first redirect", async () => {
    expect(
      await refusal(pinnedFetch(at("/hop"), {}, { ...opts, maxRedirects: 0 })),
    ).toBe("tooManyRedirects")
  })

  test("redirect: manual returns the 3xx; redirect: error throws", async () => {
    const manual = await pinnedFetch(at("/hop"), { redirect: "manual" }, opts)
    expect(manual.status).toBe(307)
    expect(manual.headers.get("location")).toBe("/ok")
    expect(
      await refusal(pinnedFetch(at("/hop"), { redirect: "error" }, opts)),
    ).toBe("unsafeRedirect")
  })

  test("307 replays the POST body; 303 and 302 turn a POST into a bodyless GET", async () => {
    const init = { method: "POST", body: "payload" }
    expect(await (await pinnedFetch(at("/post-307"), init, opts)).text()).toBe(
      "POST",
    )
    expect(hits.at(-1)).toMatchObject({ method: "POST", body: "payload" })
    for (const path of ["/post-303", "/post-302"]) {
      expect(await (await pinnedFetch(at(path), init, opts)).text()).toBe("GET")
      expect(hits.at(-1)).toMatchObject({ method: "GET", body: "" })
    }
  })

  test("a cross-origin hop drops Authorization; a same-origin hop keeps it", async () => {
    const headers = { authorization: "Bearer secret" }
    await pinnedFetch(at("/post-307"), { headers }, opts)
    expect(hits.at(-1)?.auth).toBe("Bearer secret")
    await pinnedFetch(at("/to-other-origin"), { headers }, opts)
    expect(hits.at(-1)).toMatchObject({ path: "/echo", auth: undefined })
  })

  test("one deadline for the whole chain", async () => {
    const started = Date.now()
    const error = await pinnedFetch(
      at("/slow-hop"),
      {},
      {
        ...opts,
        timeoutMs: 300,
        maxRedirects: 50,
      },
    ).then(
      () => null,
      (e: Error) => e,
    )
    expect(error?.name).toBe("TimeoutError")
    expect(Date.now() - started).toBeLessThan(2000)
  })

  test("the caller's signal still aborts", async () => {
    const controller = new AbortController()
    const pending = pinnedFetch(
      at("/slow-hop"),
      { signal: controller.signal },
      opts,
    )
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
  })

  test("decodes a gzip body and passes a null-body status through", async () => {
    expect(await (await pinnedFetch(at("/gzip"), {}, opts)).text()).toBe(
      "UNZIPPED",
    )
    const empty = await pinnedFetch(at("/no-content"), {}, opts)
    expect(empty.status).toBe(204)
    expect(empty.body).toBeNull()
  })

  // The deadline spans the body read, not only the headers (the class the
  // s215 skeptic found in the image fetcher).
  test("a body that stalls is cut off by the deadline", async () => {
    const started = Date.now()
    const response = await pinnedFetch(
      at("/stall"),
      {},
      {
        ...opts,
        timeoutMs: 300,
      },
    )
    await expect(response.text()).rejects.toMatchObject({
      name: "TimeoutError",
    })
    expect(Date.now() - started).toBeLessThan(1500)
  })

  test("a reset mid-body rejects the read, not a hang", async () => {
    const response = await pinnedFetch(
      at("/reset-mid-body"),
      {},
      {
        ...opts,
        timeoutMs: 2000,
      },
    )
    await expect(response.text()).rejects.toThrow()
  })

  test("a caller-set Host header is ignored; the URL's host is sent", async () => {
    const response = await pinnedFetch(
      at("/host"),
      { headers: { host: "internal.admin" } },
      opts,
    )
    expect(await response.text()).toBe(`site.test:${port}`)
  })

  test("an unresolvable name is a network error, not a refusal", async () => {
    const error = await pinnedFetch(at("/ok", "nowhere.test"), {}, opts).then(
      () => null,
      (e: unknown) => e,
    )
    expect(error).not.toBeNull()
    expect(error).not.toBeInstanceOf(SsrfFetchError)
  })
})
