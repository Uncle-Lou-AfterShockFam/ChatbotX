// @vitest-environment node

import http from "node:http"
import type { AddressInfo } from "node:net"
import { isBlockedIp } from "@chatbotx.io/business"
import {
  installPinnedOutboundFetch,
  pinnedFetch,
} from "@chatbotx.io/business/net-node"
import { integration as activeCampaign } from "@chatbotx.io/integration-active-campaign"
import { uploadAttachment } from "@chatbotx.io/integration-zalo"
import {
  registerOutboundFetch,
  SsrfFetchError,
  uninstallOutboundFetch,
} from "@chatbotx.io/sdk/outbound-fetch"
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest"

// s219: the integration clients that fetch a workspace- or flow-supplied URL
// go through the REAL pinned fetch the worker installs at boot. A local
// server stands in for an internal service: every private target is refused
// at connect and the server never sees a request.
let server: http.Server
let port = 0
let hits: string[] = []

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(
      `${req.headers.host} ${req.method} ${req.url} ${req.headers["api-token"] ?? "-"}`,
    )
    // Keyed on the Host: a redirecting "public" host for the seam tests.
    const redirects: Record<string, string> = {
      "to-private.test": "http://10.9.9.9/api/3/accounts",
      "to-other.test": `http://other.test:${port}/api/3/accounts`,
    }
    const location = redirects[(req.headers.host ?? "").split(":")[0] ?? ""]
    if (location) {
      res.writeHead(302, { location })
      res.end()
      return
    }
    res.writeHead(200, { "content-type": "application/json" })
    res.end("{}")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  port = (server.address() as AddressInfo).port
  installPinnedOutboundFetch()
})

afterAll(async () => {
  uninstallOutboundFetch()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

afterEach(() => {
  hits = []
})

// PORT is substituted inside each test: test.each is collected before
// beforeAll has bound the server.
const PRIVATE_TARGETS = [
  "http://127.0.0.1:PORT",
  "http://localhost:PORT",
  "http://[::1]:PORT",
  "http://169.254.169.254",
  "http://10.0.0.1",
  "http://[::ffff:127.0.0.1]:PORT",
]
const target = (template: string) => template.replace("PORT", String(port))

test("the local server is reachable unpinned (so zero hits means refused)", async () => {
  const response = await globalThis.fetch(`http://127.0.0.1:${port}/probe`)
  expect(response.status).toBe(200)
  expect(hits).toEqual([`127.0.0.1:${port} GET /probe -`])
})

const zaloAuth = {
  tokens: { accessToken: "t" },
} as Parameters<typeof uploadAttachment>[0]

describe("Zalo uploadAttachment", () => {
  test.each(PRIVATE_TARGETS)("refuses %s before dialling", async (template) => {
    const base = target(template)
    const error = await uploadAttachment(
      zaloAuth,
      "file",
      `${base}/x.pdf`,
    ).catch((caught: unknown) => caught)

    expect(
      (error as { getOriginError: () => unknown }).getOriginError(),
    ).toBeInstanceOf(SsrfFetchError)
    expect(hits).toEqual([])
  })
})

describe("ActiveCampaign client", () => {
  test.each(
    PRIVATE_TARGETS,
  )("refuses apiUrl %s before dialling", async (template) => {
    const base = target(template)
    const error = await activeCampaign
      .runAction("validateCredentials", {
        props: { apiUrl: base, apiKey: "key" },
      })
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(SsrfFetchError)
    expect(hits).toEqual([])
  })
})

// The public-host topology: the local server plays a PUBLIC host (the test
// resolver maps site.test / other.test to it and the guard lets only that
// loopback through). A workspace apiUrl whose host redirects - to a private
// address or to another public origin - is refused at the first 3xx, so the
// Api-Token never reaches a second host.
describe("ActiveCampaign client behind a redirecting public host", () => {
  const resolver = (hostname: string) =>
    ["site.test", "other.test", "to-private.test", "to-other.test"].includes(
      hostname,
    )
      ? Promise.resolve([{ address: "127.0.0.1", family: 4 }])
      : Promise.reject(new Error(`ENOTFOUND ${hostname}`))
  const isBlocked = (ip: string) => ip !== "127.0.0.1" && isBlockedIp(ip)

  beforeAll(() => {
    registerOutboundFetch((input, init, options) =>
      pinnedFetch(input, init ?? {}, { ...options, resolver, isBlocked }),
    )
  })

  test("the seam host itself is reachable (the refusals below are real)", async () => {
    await activeCampaign.runAction("validateCredentials", {
      props: { apiUrl: `http://site.test:${port}`, apiKey: "key" },
    })
    expect(hits).toEqual([`site.test:${port} GET /api/3/accounts key`])
  })

  test.each([
    "to-private",
    "to-other",
  ])("a %s redirect is refused after one hop", async (route) => {
    const error = await activeCampaign
      .runAction("validateCredentials", {
        props: { apiUrl: `http://${route}.test:${port}`, apiKey: "key" },
      })
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(Error)
    expect(hits).toEqual([`${route}.test:${port} GET /api/3/accounts key`])
  })
})
