import { createHmac, randomBytes } from "node:crypto"
import { beforeEach, describe, expect, test, vi } from "vitest"

/**
 * handleWooCommerceWebhook (s211b) with the REAL Standard Webhooks check:
 * every delivery is signed here exactly as hub-connector's Signer signs it.
 * Mocked: the site credentials lookup, the contact marks, the emitters and
 * the database at the query-builder seam. Pinned: verify -> parse -> lock ->
 * dedup -> CAS -> marks order, that an unknown site answers like a bad
 * signature (and is retried, never dead-lettered), that a duplicate never
 * marks, that marks run once per status however many events report it, that
 * a refund before its payment is retried with nothing recorded, and that a
 * payment of an invoice voided here is flagged, never applied (s211b review).
 */

const SECRET = `whsec_${randomBytes(32).toString("base64")}`
const OTHER_SECRET = `whsec_${randomBytes(32).toString("base64")}`
const INTEGRATION_ID = "88"
const WORKSPACE_ID = "11"
const HUB_ID = "501"
const ORDER_ID = "3701"
const SITE_URL = "https://bakery.example.org"
const ORDER_REF = `wc:${SITE_URL}:${ORDER_ID}`

const m = vi.hoisted(() => {
  const state = {
    hubRow: null as Record<string, unknown> | null,
    /** Rows of the `marked:<status>` lookup (after the lock select). */
    markedRows: [] as { id: string }[],
    selects: 0,
    insertResult: [{ id: "ev-row" }] as { id: string }[],
    transitionMatches: true,
    inserted: [] as Record<string, unknown>[],
    updates: [] as Record<string, unknown>[],
    deletes: 0,
    transactionError: null as Error | null,
  }
  const selectChain: Record<string, unknown> = {}
  selectChain.from = () => selectChain
  selectChain.where = () => selectChain
  // 1st select of a delivery = the invoice lock, 2nd = the marked lookup.
  selectChain.limit = () => {
    state.selects += 1
    const locked = state.hubRow ? [{ ...state.hubRow }] : []
    const rows = state.selects === 1 ? locked : state.markedRows
    const result = Promise.resolve(rows)
    return Object.assign(result, { for: () => result })
  }
  const updateChain = {
    pending: {} as Record<string, unknown>,
    set(v: Record<string, unknown>) {
      updateChain.pending = v
      state.updates.push(v)
      return updateChain
    },
    where: () => updateChain,
    returning: () =>
      Promise.resolve(
        state.transitionMatches && state.hubRow
          ? [{ ...state.hubRow, ...updateChain.pending }]
          : [],
      ),
    // biome-ignore lint/suspicious/noThenProperty: awaited query-builder stub
    then: (resolve: (v: unknown) => unknown) => resolve(undefined),
  }
  const tx = {
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        state.inserted.push(v)
        return {
          onConflictDoNothing: () => ({
            returning: () => Promise.resolve(state.insertResult),
          }),
        }
      },
    }),
    update: () => updateChain,
    select: () => selectChain,
  }
  const db = {
    select: () => selectChain,
    update: () => updateChain,
    transaction: async (cb: (t: unknown) => unknown) => {
      if (state.transactionError) {
        throw state.transactionError
      }
      return await cb(tx)
    },
    delete: () => ({
      where: () => {
        state.deletes += 1
        return Promise.resolve()
      },
    }),
  }
  return {
    state,
    db,
    credentials: vi.fn(),
    marks: vi.fn(),
    emitPaid: vi.fn(),
    prerender: vi.fn(() => Promise.resolve()),
  }
})

vi.mock("@chatbotx.io/database/client", () => ({
  db: m.db,
  and: (...c: unknown[]) => ({ and: c }),
  or: (...c: unknown[]) => ({ or: c }),
  eq: (_f: unknown, v: unknown) => ({ eq: v }),
  inArray: (_f: unknown, v: unknown) => ({ in: v }),
  isNull: () => ({ isNull: true }),
  sql: Object.assign(
    (s: TemplateStringsArray, ...v: unknown[]) => ({ s, v }),
    {},
  ),
}))
vi.mock("../src/integration-woocommerce/service", () => ({
  integrationWooCommerceService: {
    credentialsByIntegrationId: (...a: unknown[]) => m.credentials(...a),
  },
}))
vi.mock("../src/invoice/contact-marks", () => ({
  markInvoiceOnContact: (...a: unknown[]) => m.marks(...a),
  markInvoiceCreated: vi.fn(),
}))
vi.mock("@chatbotx.io/events", () => ({
  emitInvoicePaid: (...a: unknown[]) => m.emitPaid(...a),
  emitInvoicePaymentFailed: vi.fn(),
  emitInvoiceCreated: vi.fn(),
}))
vi.mock("../src/audit/dispatcher", () => ({ dispatchAuditRecord: vi.fn() }))
vi.mock("../src/invoice/document", () => ({
  prerenderInvoiceReceipt: (...a: unknown[]) => m.prerender(...a),
}))
vi.mock("../src/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

const { handleWooCommerceWebhook, verifyStandardWebhook, parseOrderEnvelope } =
  await import("../src/invoice/woocommerce-webhook")

const NOW = 1_790_000_000

/** hub-connector Signer::sign: v1,<base64 HMAC-SHA256(key, "{id}.{ts}.{body}")>. */
function sign(secret: string, id: string, ts: number, body: string): string {
  const key = Buffer.from(secret.slice("whsec_".length), "base64")
  return `v1,${createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64")}`
}

function envelope(
  over: {
    id?: string
    event?: string
    orderId?: string
    hubInvoiceId?: string | null
  } = {},
): string {
  const fields: Record<string, string> = {
    order_id: over.orderId ?? ORDER_ID,
    order_total: "42.50",
  }
  if (over.hubInvoiceId !== null) {
    fields.hub_invoice_id = over.hubInvoiceId ?? HUB_ID
  }
  return JSON.stringify({
    spec: "hub-connector/1",
    id: over.id ?? `hc-order-${over.orderId ?? ORDER_ID}-paid`,
    event: over.event ?? "order.paid",
    occurred_at: "2026-09-27T01:00:00Z",
    site: { slug: "bakery-test", url: "https://bakery.example.org/" },
    contact: { phone: "+15550004242" },
    subject: {
      type: "order",
      id: over.orderId ?? ORDER_ID,
      title: `Order #${over.orderId ?? ORDER_ID}`,
    },
    fields,
  })
}

function deliver(
  body: string,
  opts: { secret?: string; ts?: number; idHeader?: string } = {},
) {
  const id = opts.idHeader ?? (JSON.parse(body) as { id: string }).id
  const ts = opts.ts ?? NOW
  return handleWooCommerceWebhook({
    integrationId: INTEGRATION_ID,
    rawBody: Buffer.from(body),
    headers: {
      id,
      timestamp: String(ts),
      signature: sign(opts.secret ?? SECRET, id, ts, body),
    },
    nowSeconds: NOW,
  })
}

const openInvoice = (over: Record<string, unknown> = {}) => ({
  id: HUB_ID,
  workspaceId: WORKSPACE_ID,
  contactId: "31",
  integrationId: INTEGRATION_ID,
  method: "woocommerce",
  status: "open",
  number: 7,
  total: "42.50",
  currency: "USD",
  hostedUrl: "https://bakery.example.org/checkout/order-pay/3701/",
  providerInvoiceId: ORDER_REF,
  providerAccountId: SITE_URL,
  dealId: null,
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  m.state.hubRow = openInvoice()
  m.state.insertResult = [{ id: "ev-row" }]
  m.state.transitionMatches = true
  m.state.inserted = []
  m.state.updates = []
  m.state.deletes = 0
  m.state.transactionError = null
  m.state.markedRows = []
  m.state.selects = 0
  m.credentials.mockResolvedValue({
    integrationId: INTEGRATION_ID,
    workspaceId: WORKSPACE_ID,
    siteSlug: "bakery-test",
    siteUrl: SITE_URL,
    currency: "USD",
    auth: { actionToken: "btc_x", webhookSecret: SECRET },
  })
  m.marks.mockResolvedValue(undefined)
  m.emitPaid.mockResolvedValue(undefined)
})

describe("verifyStandardWebhook", () => {
  const body = Buffer.from('{"a":1}')
  const ok = (over: Partial<Parameters<typeof verifyStandardWebhook>[0]>) =>
    verifyStandardWebhook({
      secret: SECRET,
      id: "e1",
      timestamp: String(NOW),
      signature: sign(SECRET, "e1", NOW, '{"a":1}'),
      rawBody: body,
      nowSeconds: NOW,
      ...over,
    })

  test("accepts the plugin's own signature", () => {
    expect(ok({})).toBe(true)
  })
  test.each([
    ["an empty secret", ""],
    ["a secret without whsec_", SECRET.slice("whsec_".length)],
    ["a bare prefix", "whsec_"],
  ])("refuses %s even with a signature made from it", (_label, secret) => {
    expect(ok({ secret, signature: sign(secret, "e1", NOW, '{"a":1}') })).toBe(
      false,
    )
  })
  test("accepts one valid signature among several (rotation)", () => {
    expect(
      ok({
        signature: `v1,${Buffer.alloc(32).toString("base64")} ${sign(SECRET, "e1", NOW, '{"a":1}')}`,
      }),
    ).toBe(true)
  })
  test.each([
    ["another secret", { secret: OTHER_SECRET }],
    ["another id", { id: "e2" }],
    ["a stale timestamp", { nowSeconds: NOW + 301 }],
    ["a future timestamp", { nowSeconds: NOW - 301 }],
    ["a non-numeric timestamp", { timestamp: "12e3" }],
    ["no signature", { signature: null }],
    ["no id", { id: null }],
    ["a v2 signature", { signature: "v2,abc" }],
    ["a truncated signature", { signature: "v1,AAAA" }],
    ["a tampered body", { rawBody: Buffer.from('{"a":2}') }],
  ])("refuses %s", (_label, over) => {
    expect(ok(over as never)).toBe(false)
  })
})

describe("parseOrderEnvelope", () => {
  test("reads id, event, order id and hub invoice id", () => {
    expect(parseOrderEnvelope(Buffer.from(envelope()))).toEqual({
      id: `hc-order-${ORDER_ID}-paid`,
      event: "order.paid",
      orderId: ORDER_ID,
      hubInvoiceId: HUB_ID,
    })
  })
  test.each([
    ["not json", "{"],
    ["a list", "[]"],
    ["another spec", JSON.stringify({ spec: "x", id: "a", event: "e" })],
    [
      "an id with @",
      JSON.stringify({ spec: "hub-connector/1", id: "a@hub", event: "e" }),
    ],
  ])("refuses %s", (_label, raw) => {
    expect(parseOrderEnvelope(Buffer.from(raw))).toBeNull()
  })
  test("property: random bytes never throw", () => {
    for (let i = 0; i < 500; i++) {
      expect(() => parseOrderEnvelope(randomBytes(i % 64))).not.toThrow()
    }
  })
})

describe("handleWooCommerceWebhook", () => {
  const deliverAgain = (body: string) => {
    m.state.selects = 0
    return deliver(body)
  }

  test("a paid order moves the invoice to paid, marks the contact once and records the marks", async () => {
    const result = await deliver(envelope())
    expect(result.reason).toBe("applied")
    expect(m.state.inserted[0]).toMatchObject({
      integrationId: INTEGRATION_ID,
      workspaceId: WORKSPACE_ID,
      providerEventId: `hc-order-${ORDER_ID}-paid`,
      invoiceId: HUB_ID,
      outcome: "received",
    })
    expect(m.state.updates[0]).toMatchObject({
      status: "paid",
      providerInvoiceId: ORDER_REF,
    })
    expect(m.marks).toHaveBeenCalledWith(
      expect.objectContaining({ status: "paid" }),
    )
    expect(m.emitPaid).toHaveBeenCalledTimes(1)
    expect(m.state.updates.at(-1)).toMatchObject({ outcome: "marked:paid" })
    // s213b: the hub receipt is stored now, so invoice_pdf_link is instant.
    expect(m.prerender).toHaveBeenCalledWith(HUB_ID)
  })

  test("a receipt pre-render that fails never fails the delivery", async () => {
    m.prerender.mockRejectedValueOnce(new Error("gotenberg down"))
    const result = await deliver(envelope())
    expect(result.reason).toBe("applied")
  })

  test("an unknown site and a bad signature answer the same retryable no-token, and touch nothing", async () => {
    const bad = await deliver(envelope(), { secret: OTHER_SECRET })
    m.credentials.mockResolvedValueOnce(null)
    const unknown = await deliverAgain(envelope())
    expect([bad.reason, unknown.reason]).toEqual(["no-token", "no-token"])
    expect(m.state.inserted).toEqual([])
    expect(m.state.selects).toBe(0)
    expect(m.marks).not.toHaveBeenCalled()
  })

  test("a header id that differs from the envelope id is refused", async () => {
    const result = await deliver(envelope(), { idHeader: "hc-order-1-paid" })
    expect(result.reason).toBe("invalid:envelope")
    expect(m.state.inserted).toEqual([])
  })

  test("a redelivery is a duplicate: no marks, no emit", async () => {
    m.state.insertResult = []
    const result = await deliver(envelope())
    expect(result.reason).toBe("duplicate")
    expect(m.marks).not.toHaveBeenCalled()
    expect(m.emitPaid).not.toHaveBeenCalled()
  })

  test.each([
    "constructor",
    "__proto__",
    "toString",
    "hasOwnProperty",
  ])("the event name %s is captured, never looked up on a prototype", async (event) => {
    const result = await deliver(envelope({ event, id: "hc-order-3701-x" }))
    expect(result.reason).toBe("captured")
    expect(m.state.inserted).toEqual([])
  })

  test.each([
    ["no hub invoice", { hubInvoiceId: null }],
    ["a junk hub invoice id", { hubInvoiceId: "12 OR 1" }],
    ["a hub invoice id over bigint", { hubInvoiceId: "99999999999999999999" }],
    ["an order id over bigint", { orderId: "9223372036854775808" }],
  ])("%s is captured untouched (no query)", async (_label, over) => {
    const result = await deliver(envelope(over as never))
    expect(result.reason).toBe("captured")
    expect(m.state.selects).toBe(0)
  })

  test("an order this site cannot match yet is retried and burns no event id", async () => {
    m.state.hubRow = null
    const result = await deliver(envelope())
    expect(result.reason).toBe("hub-error")
    expect(m.state.inserted).toEqual([])
    expect(m.state.updates).toEqual([])
  })

  test("a refund before its payment is retried, with nothing recorded", async () => {
    for (const status of ["open", "draft", "uncollectible"]) {
      m.state.hubRow = openInvoice({ status })
      const result = await deliverAgain(
        envelope({ event: "order.refunded", id: "hc-order-3701-refunded" }),
      )
      expect(result.reason).toBe("hub-error")
    }
    expect(m.state.inserted).toEqual([])
    expect(m.marks).not.toHaveBeenCalled()
  })

  test("paid after a void here: flagged on the event and the invoice, never applied", async () => {
    m.state.hubRow = openInvoice({ status: "void", providerInvoiceId: null })
    m.state.transitionMatches = false
    const result = await deliver(envelope())
    expect(result.reason).toBe("captured")
    expect(m.state.updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outcome: "paid-after-void" }),
        expect.objectContaining({
          providerInvoiceId: ORDER_REF,
          lastError: expect.stringContaining("refund it in WooCommerce"),
        }),
      ]),
    )
    expect(m.marks).not.toHaveBeenCalled()
    expect(m.emitPaid).not.toHaveBeenCalled()
    expect(m.prerender).not.toHaveBeenCalled()
  })

  test("a refund moves a paid invoice to refunded and marks it, without a paid emit", async () => {
    m.state.hubRow = openInvoice({ status: "paid" })
    const result = await deliver(
      envelope({ event: "order.refunded", id: "hc-order-3701-refunded" }),
    )
    expect(result.reason).toBe("applied")
    expect(m.state.updates[0]).toMatchObject({ status: "refunded" })
    expect(m.marks).toHaveBeenCalledWith(
      expect.objectContaining({ status: "refunded" }),
    )
    expect(m.emitPaid).not.toHaveBeenCalled()
    expect(m.prerender).not.toHaveBeenCalled()
  })

  test("order.completed pays an unpaid invoice (a manual-payment order)", async () => {
    const result = await deliver(
      envelope({ event: "order.completed", id: "hc-order-3701-completed" }),
    )
    expect(result.reason).toBe("applied")
    expect(m.state.updates[0]).toMatchObject({ status: "paid" })
    expect(m.emitPaid).toHaveBeenCalledTimes(1)
  })

  test("a second report of a marked status (order.completed after order.paid) never re-marks", async () => {
    m.state.hubRow = openInvoice({ status: "paid" })
    m.state.transitionMatches = false
    m.state.markedRows = [{ id: "ev-marked" }]
    const result = await deliver(
      envelope({ event: "order.completed", id: "hc-order-3701-completed" }),
    )
    expect(result.reason).toBe("captured")
    expect(m.marks).not.toHaveBeenCalled()
    expect(m.emitPaid).not.toHaveBeenCalled()
  })

  test("a failed mark drops the dedup row and asks the site to retry the same id", async () => {
    m.marks.mockRejectedValueOnce(new Error("hub down"))
    const result = await deliver(envelope())
    expect(result.reason).toBe("hub-error")
    expect(m.state.deletes).toBe(1)
    expect(m.state.updates).not.toContainEqual(
      expect.objectContaining({ outcome: "marked:paid" }),
    )
  })

  test("the retry after a failed mark (status reached, no marks recorded) runs the marks", async () => {
    m.state.hubRow = openInvoice({ status: "paid" })
    m.state.transitionMatches = false
    const result = await deliver(envelope())
    expect(result.reason).toBe("captured")
    expect(m.marks).toHaveBeenCalledWith(
      expect.objectContaining({ status: "paid" }),
    )
    expect(m.emitPaid).toHaveBeenCalledTimes(1)
    expect(m.state.updates.at(-1)).toMatchObject({ outcome: "marked:paid" })
  })

  test("a database failure answers hub-error (the site retries)", async () => {
    m.state.transactionError = new Error("connection terminated")
    const result = await deliver(envelope())
    expect(result.reason).toBe("hub-error")
    expect(m.marks).not.toHaveBeenCalled()
  })
})
