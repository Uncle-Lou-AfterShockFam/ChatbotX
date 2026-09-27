import { beforeEach, describe, expect, test, vi } from "vitest"

/**
 * WooCommerce sites (s211b): the connect probe and how its answer maps to a
 * link or a refusal, that a re-link keeps the site's webhook secret, and the
 * site a new invoice binds to. Encryption, the SSRF guard, fetch and the
 * database are mocked.
 */

const WORKSPACE_ID = "11"
const TOKEN = `btc_${"a".repeat(43)}`
const SECRET_RE = /^whsec_[A-Za-z0-9+/]{43}=$/

const m = vi.hoisted(() => ({
  fetch: vi.fn(),
  existing: null as Record<string, unknown> | null,
  sites: [] as Record<string, unknown>[],
  inserts: [] as Record<string, unknown>[],
  updates: [] as Record<string, unknown>[],
  encrypted: [] as unknown[],
  audit: vi.fn(),
}))

vi.mock("@chatbotx.io/database/client", () => {
  const writeChain = (bucket: Record<string, unknown>[]) => {
    const chain: Record<string, unknown> = {}
    chain.values = (v: Record<string, unknown>) => {
      bucket.push(v)
      return chain
    }
    chain.set = (v: Record<string, unknown>) => {
      bucket.push(v)
      return chain
    }
    chain.where = () => chain
    chain.returning = () =>
      Promise.resolve([
        {
          id: "900",
          integrationId: (m.existing?.integrationId as string) ?? "901",
          workspaceId: WORKSPACE_ID,
          siteSlug: "bakery-test",
          siteUrl: "https://bakery.example.org",
          tokenLast4: TOKEN.slice(-4),
          currency: "USD",
          auth: {},
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ])
    // biome-ignore lint/suspicious/noThenProperty: awaited query-builder stub
    chain.then = (resolve: (v: unknown) => unknown) => resolve(undefined)
    return chain
  }
  const query = {
    integrationWooCommerceModel: {
      findFirst: () => Promise.resolve(m.existing ?? undefined),
      findMany: () => Promise.resolve(m.sites),
    },
  }
  const tx = {
    execute: () => Promise.resolve(undefined),
    query,
    insert: () => writeChain(m.inserts),
    update: () => writeChain(m.updates),
  }
  return {
    db: {
      ...tx,
      transaction: async (cb: (t: unknown) => unknown) => await cb(tx),
    },
    and: (...c: unknown[]) => ({ and: c }),
    eq: (_f: unknown, v: unknown) => ({ eq: v }),
    isNull: () => ({ isNull: true }),
    sql: () => ({}),
  }
})
vi.mock("@chatbotx.io/encryption", () => ({
  encryptedDataSchema: { parse: (v: unknown) => v },
  encryptUtils: {
    encryptObject: (v: unknown) => {
      m.encrypted.push(v)
      return Promise.resolve({ sealed: v })
    },
    decryptObject: (v: { sealed: unknown }) => Promise.resolve(v.sealed),
  },
}))
vi.mock("../src/net/ssrf-guard", () => ({
  isSsrfUnsafeUrl: () => Promise.resolve(false),
}))
vi.mock("../src/audit/dispatcher", () => ({
  dispatchAuditRecord: (...a: unknown[]) => m.audit(...a),
}))

const { integrationWooCommerceService } = await import(
  "../src/integration-woocommerce/service"
)

const answer = (status: number, code: string) =>
  new Response(JSON.stringify({ ok: false, status: "error", code }), {
    status,
  })
const storeInfo = (currency = "usd") =>
  new Response(
    JSON.stringify({
      ok: true,
      status: "info",
      plugin_version: "0.6.0",
      currency,
    }),
    { status: 200 },
  )

const connect = (over: Record<string, unknown> = {}) =>
  integrationWooCommerceService.connect({
    workspaceId: WORKSPACE_ID,
    siteSlug: "bakery-test",
    siteUrl: "https://bakery.example.org/",
    actionToken: TOKEN,
    webhookUrlFor: (id: string) =>
      `https://chat.example.org/integrations/woocommerce/webhook/${id}`,
    ...over,
  })

beforeEach(() => {
  m.fetch.mockReset()
  vi.stubGlobal("fetch", m.fetch)
  m.existing = null
  m.sites = []
  m.inserts = []
  m.updates = []
  m.encrypted = []
})

describe("connect", () => {
  test("a 0.6.0 site links through the read-only store.info, takes its currency, and the wp-config lines come back once", async () => {
    m.fetch.mockResolvedValue(storeInfo())
    const result = await connect()
    const [url, init] = m.fetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(
      "https://bakery.example.org/wp-json/hub-connector/v1/actions/store.info",
    )
    expect(m.fetch).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(init.body))).toEqual({})
    expect(result.hubUrl).toBe(
      "https://chat.example.org/integrations/woocommerce/webhook/901",
    )
    expect(result.hubSecret).toMatch(SECRET_RE)
    expect(m.inserts[0]).toMatchObject({ integrationType: "woocommerce" })
    expect(m.inserts[1]).toMatchObject({
      siteSlug: "bakery-test",
      siteUrl: "https://bakery.example.org",
      currency: "USD",
      tokenLast4: TOKEN.slice(-4),
    })
    expect(m.encrypted[0]).toEqual({
      actionToken: TOKEN,
      webhookSecret: result.hubSecret,
    })
    // The token reaches the database only inside the encrypted auth blob.
    const { auth, ...columns } = m.inserts[1] as Record<string, unknown>
    expect(auth).toEqual({ sealed: m.encrypted[0] })
    expect(JSON.stringify(columns)).not.toContain(TOKEN)
  })

  test("re-linking the same slug AT THE SAME URL keeps its webhook secret (a token rotation)", async () => {
    const kept = `whsec_${"b".repeat(43)}=`
    m.existing = {
      id: "900",
      integrationId: "777",
      workspaceId: WORKSPACE_ID,
      siteSlug: "bakery-test",
      siteUrl: "https://bakery.example.org",
      auth: { sealed: { actionToken: TOKEN, webhookSecret: kept } },
    }
    m.fetch.mockResolvedValue(storeInfo())
    const result = await connect()
    expect(result.hubSecret).toBe(kept)
    expect(result.hubUrl).toContain("/webhook/777")
    expect(m.inserts).toEqual([])
  })

  test("re-pointing a slug at another URL mints a NEW secret (the old install can no longer sign)", async () => {
    const old = `whsec_${"b".repeat(43)}=`
    m.existing = {
      id: "900",
      integrationId: "777",
      workspaceId: WORKSPACE_ID,
      siteSlug: "bakery-test",
      siteUrl: "https://old-shop.example.org",
      auth: { sealed: { actionToken: TOKEN, webhookSecret: old } },
    }
    m.fetch.mockResolvedValue(storeInfo())
    const result = await connect()
    expect(result.hubSecret).toMatch(SECRET_RE)
    expect(result.hubSecret).not.toBe(old)
    expect(m.updates[0]).toMatchObject({
      siteUrl: "https://bakery.example.org",
    })
  })

  test("the store currency comes from the site (an unsupported one is refused)", async () => {
    m.fetch.mockResolvedValue(storeInfo("xyz1"))
    await expect(connect()).rejects.toThrow("not supported")
    expect(m.inserts).toEqual([])
  })

  test.each([
    [401, "unknown-token", "rejected this token"],
    [403, "scope", "orders:write"],
    [404, "unknown-action", "older than 0.6.0"],
    [422, "no-provider", "WooCommerce is not active"],
    [404, "rest_no_route", "No hub-connector"],
    [200, "", "Unexpected answer"],
    [500, "error", "Unexpected answer"],
  ])("a probe answered %i %s is refused (%s) and writes nothing", async (status, code, message) => {
    m.fetch.mockResolvedValue(answer(status, code))
    await expect(connect()).rejects.toThrow(message)
    expect(m.inserts).toEqual([])
  })

  test.each([
    ["http", { siteUrl: "http://bakery.example.org" }],
    ["a path", { siteUrl: "https://bakery.example.org/shop" }],
    ["a bad slug", { siteSlug: "Bakery Test" }],
    ["a bad token", { actionToken: "sk_test_x" }],
  ])("%s is refused before any call", async (_label, over) => {
    await expect(connect(over)).rejects.toThrow()
    expect(m.fetch).not.toHaveBeenCalled()
  })

  test("an unreachable site is refused", async () => {
    m.fetch.mockRejectedValue(new TypeError("fetch failed"))
    await expect(connect()).rejects.toThrow("did not answer")
  })
})

describe("credentialsForNewInvoice", () => {
  const site = (integrationId: string) => ({
    id: `row-${integrationId}`,
    integrationId,
    workspaceId: WORKSPACE_ID,
    siteSlug: `site-${integrationId}`,
    siteUrl: "https://bakery.example.org",
    currency: "USD",
    auth: { sealed: { actionToken: TOKEN, webhookSecret: "whsec_x" } },
  })

  test("the only site is used when none is named", async () => {
    m.sites = [site("5")]
    const credentials =
      await integrationWooCommerceService.credentialsForNewInvoice(
        WORKSPACE_ID,
        undefined,
      )
    expect(credentials.integrationId).toBe("5")
  })

  test("several sites and none named is refused, never guessed", async () => {
    m.sites = [site("5"), site("6")]
    await expect(
      integrationWooCommerceService.credentialsForNewInvoice(
        WORKSPACE_ID,
        undefined,
      ),
    ).rejects.toThrow("pick one")
  })

  test("no site is a missing credential", async () => {
    await expect(
      integrationWooCommerceService.credentialsForNewInvoice(WORKSPACE_ID, "5"),
    ).rejects.toThrow("not connected")
  })
})
