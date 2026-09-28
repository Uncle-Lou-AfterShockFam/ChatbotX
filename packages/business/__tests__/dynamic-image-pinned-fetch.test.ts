// @vitest-environment node

import http from "node:http"
import type { AddressInfo } from "node:net"
import { gzipSync } from "node:zlib"
import { server as msw } from "@chatbotx.io/vitest-config/msw"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"
import {
  fetchImageBytes,
  guardedLookup,
  ImageFetchRefusedError,
} from "../src/dynamic-image/pinned-fetch"
import { loadRemoteImage } from "../src/dynamic-image/render"
import { isBlockedIp } from "../src/net/ssrf-guard"

// s215 (Codex): the SSRF check must be bound to the connection, per hop. A
// real local server stands in for the internet; a test resolver maps names to
// it, and `isBlocked` lets the server's own 127.0.0.1 count as "public" only
// in the tests that need a reachable target.
let server: http.Server
let port = 0
let hits: string[] = []

beforeAll(async () => {
  // MSW patches node:http for the whole package; this file talks to a real
  // local server (the pinned `lookup` is the thing under test), so it steps
  // out and puts it back for the shared teardown.
  msw.close()
  server = http.createServer((req, res) => {
    hits.push(req.url ?? "")
    const path = req.url ?? ""
    if (path === "/ok.png") {
      res.writeHead(200, { "content-type": "image/png" })
      res.end("PNGDATA")
    } else if (path === "/hop") {
      res.writeHead(307, { location: "/ok.png" })
      res.end()
    } else if (path === "/to-private-literal") {
      res.writeHead(302, { location: "http://10.9.9.9/x.png" })
      res.end()
    } else if (path === "/to-private-name") {
      res.writeHead(302, { location: `http://evil.test:${port}/ok.png` })
      res.end()
    } else if (path === "/to-file") {
      res.writeHead(302, { location: "file:///etc/passwd" })
      res.end()
    } else if (path === "/loop") {
      res.writeHead(302, { location: "/loop" })
      res.end()
    } else if (path === "/no-location") {
      res.writeHead(302)
      res.end()
    } else if (path === "/gzip.png") {
      res.writeHead(200, { "content-encoding": "gzip" })
      res.end(gzipSync(Buffer.from("PNGDATA")))
    } else if (path === "/gzip-bomb") {
      res.writeHead(200, { "content-encoding": "gzip" })
      res.end(gzipSync(Buffer.alloc(64 * 1024)))
    } else if (path === "/weird-encoding") {
      res.writeHead(200, { "content-encoding": "compress" })
      res.end("x")
    } else if (path === "/slow-hop") {
      setTimeout(() => {
        res.writeHead(302, { location: "/slow-hop" })
        res.end()
      }, 120)
    } else if (path === "/big") {
      res.writeHead(200)
      res.end(Buffer.alloc(2048, 1))
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
  msw.listen({ onUnhandledRequest: "error" })
})

beforeEach(() => {
  hits = []
})

// img.test -> the local server; evil.test -> a private address (10/8).
const resolver = async (hostname: string) => {
  if (hostname === "img.test") {
    return [{ address: "127.0.0.1", family: 4 }]
  }
  if (hostname === "evil.test") {
    return [{ address: "10.9.9.9", family: 4 }]
  }
  throw new Error(`ENOTFOUND ${hostname}`)
}
// Everything the real guard blocks, except the local server's loopback.
const isBlocked = (ip: string) => ip !== "127.0.0.1" && isBlockedIp(ip)
const opts = { resolver, isBlocked }
const at = (path: string) => `http://img.test:${port}${path}`

describe("guardedLookup (s215)", () => {
  const run = (
    addresses: { address: string; family: number }[],
    all: boolean,
  ) =>
    new Promise<{ error: unknown; result: unknown }>((resolve) => {
      guardedLookup(async () => addresses)(
        "x.test",
        { all } as never,
        ((error: unknown, result: unknown) =>
          resolve({ error, result })) as never,
      )
    })

  test("refuses a name with a public A and a private AAAA", async () => {
    const { error } = await run(
      [
        { address: "93.184.216.34", family: 4 },
        { address: "fd00::1", family: 6 },
      ],
      true,
    )
    expect(error).toBeInstanceOf(ImageFetchRefusedError)
  })

  test("refuses a name that resolves to nothing", async () => {
    const { error } = await run([], false)
    expect(error).toBeInstanceOf(ImageFetchRefusedError)
  })

  test("hands the socket exactly the validated addresses", async () => {
    const addresses = [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ]
    expect((await run(addresses, true)).result).toEqual(addresses)
    expect((await run(addresses, false)).result).toBe("93.184.216.34")
  })
})

describe("fetchImageBytes (s215)", () => {
  test("fetches a public image, following a relative redirect", async () => {
    const body = await fetchImageBytes(at("/hop"), opts)
    expect(body.toString()).toBe("PNGDATA")
    expect(hits).toEqual(["/hop", "/ok.png"])
  })

  test.each([
    "http://127.0.0.1:1/x.png",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/x.png",
    "http://[::ffff:127.0.0.1]/x.png",
    "http://2130706433/x.png",
    "file:///etc/passwd",
    "not a url",
  ])("refuses %s before connecting (real guard)", async (url) => {
    await expect(fetchImageBytes(url)).rejects.toMatchObject({
      reason: "unsafeUrl",
    })
  })

  test("a name resolving to a private address is refused at connect; the server never sees it", async () => {
    await expect(
      fetchImageBytes(`http://evil.test:${port}/ok.png`, opts),
    ).rejects.toMatchObject({ reason: "unsafeAddress" })
    expect(hits).toEqual([])
  })

  test("with the real guard, even the local server's own name is refused", async () => {
    await expect(
      fetchImageBytes(at("/ok.png"), { resolver }),
    ).rejects.toMatchObject({ reason: "unsafeAddress" })
    expect(hits).toEqual([])
  })

  test.each([
    ["a private IP literal", "/to-private-literal", "unsafeRedirect"],
    ["a name resolving private", "/to-private-name", "unsafeAddress"],
    ["a file: URL", "/to-file", "unsafeRedirect"],
    ["no Location", "/no-location", "unsafeRedirect"],
  ])("a redirect to %s is refused", async (_, path, reason) => {
    await expect(fetchImageBytes(at(path), opts)).rejects.toMatchObject({
      reason,
    })
    expect(hits).toEqual([path])
  })

  test("the hop cap fires", async () => {
    await expect(
      fetchImageBytes(at("/loop"), { ...opts, maxRedirects: 2 }),
    ).rejects.toMatchObject({ reason: "tooManyRedirects" })
    expect(hits).toHaveLength(3)
  })

  test("the deadline covers the whole redirect chain, not each hop", async () => {
    const started = Date.now()
    await expect(
      fetchImageBytes(at("/slow-hop"), {
        ...opts,
        maxRedirects: 50,
        timeoutMs: 300,
      }),
    ).rejects.toThrow()
    // Each hop takes 120 ms (< 300), so a per-hop deadline would run for 50.
    expect(Date.now() - started).toBeLessThan(1500)
  })

  test("the body cap fires", async () => {
    await expect(
      fetchImageBytes(at("/big"), { ...opts, maxBytes: 1024 }),
    ).rejects.toMatchObject({ reason: "tooLarge" })
  })

  test("a gzip Content-Encoding is decoded, as fetch did", async () => {
    const body = await fetchImageBytes(at("/gzip.png"), opts)
    expect(body.toString()).toBe("PNGDATA")
  })

  test("the body cap counts decoded bytes (a small gzip that inflates past it)", async () => {
    await expect(
      fetchImageBytes(at("/gzip-bomb"), { ...opts, maxBytes: 1024 }),
    ).rejects.toMatchObject({ reason: "tooLarge" })
  })

  test("an unknown Content-Encoding is refused, not handed to the decoder", async () => {
    await expect(
      fetchImageBytes(at("/weird-encoding"), opts),
    ).rejects.toMatchObject({ reason: "unsupportedEncoding" })
  })

  test("a non-2xx answer is an error, not an image", async () => {
    await expect(fetchImageBytes(at("/missing"), opts)).rejects.toMatchObject({
      reason: "httpError",
    })
  })
})

describe("loadRemoteImage uses the pinned fetch (s215)", () => {
  test.each([
    "http://127.0.0.1:3000/api/health",
    "http://169.254.169.254/latest/meta-data/",
  ])("never fetches %s", async (url) => {
    await expect(loadRemoteImage(url)).rejects.toBeInstanceOf(
      ImageFetchRefusedError,
    )
  })
})
