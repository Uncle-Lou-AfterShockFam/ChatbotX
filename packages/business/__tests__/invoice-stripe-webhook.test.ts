import Stripe from "stripe"
import { beforeEach, describe, expect, test, vi } from "vitest"

/**
 * handleStripeWebhook (s205b) with the REAL Stripe signature check: every
 * delivery is signed by `stripe.webhooks.generateTestHeaderString` and
 * verified by the real `constructEvent`. Mocked: the credentials lookup, the
 * Stripe API calls (invoices.retrieve, invoicePayments.list), the contact
 * marks, the event emitters, and the database at the query-builder seam.
 * What is pinned: the verify -> dedup -> confirm -> CAS -> marks order, that a
 * duplicate or an unconfirmed event never marks or emits, and that a failed
 * mark removes the dedup row so Stripe's redelivery is not a duplicate.
 */

const SECRET = "whsec_unitTestSecret0123456789abcdef"
const INTEGRATION_ID = "77"
const WORKSPACE_ID = "11"
const HUB_ID = "501"
const STRIPE_INVOICE_ID = "in_test_1"

const m = vi.hoisted(() => {
  const state = {
    hubRow: null as Record<string, unknown> | null,
    /** What the InvoiceEvent insert's RETURNING yields ([] = conflict). */
    insertResult: [{ id: "ev-row" }] as { id: string }[],
    /** Whether the CAS transition UPDATE matches a row. */
    transitionMatches: true,
    inserted: [] as Record<string, unknown>[],
    updates: [] as Record<string, unknown>[],
    deleteWheres: [] as unknown[],
    transactionError: null as Error | null,
  }
  const selectChain: Record<string, unknown> = {}
  selectChain.from = () => selectChain
  selectChain.where = () => selectChain
  selectChain.limit = () =>
    Promise.resolve(state.hubRow ? [{ ...state.hubRow }] : [])
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
      where: (w: unknown) => {
        state.deleteWheres.push(w)
        return Promise.resolve()
      },
    }),
  }
  return {
    state,
    db,
    credentials: vi.fn(),
    retrieve: vi.fn(),
    paymentsList: vi.fn(),
    chargeRetrieve: vi.fn(),
    sessionRetrieve: vi.fn(),
    piRetrieve: vi.fn(),
    marks: vi.fn(),
    emitPaid: vi.fn(),
    emitFailed: vi.fn(),
    emitCreated: vi.fn(),
    loggerWarn: vi.fn(),
    loggerError: vi.fn(),
  }
})

vi.mock("@chatbotx.io/database/client", () => ({
  db: m.db,
  and: (...c: unknown[]) => ({ and: c }),
  or: (...c: unknown[]) => ({ or: c }),
  // Values only: a drizzle column is circular and would break JSON.stringify.
  eq: (_f: unknown, v: unknown) => ({ eq: v }),
  exists: (q: unknown) => ({ exists: q }),
  lt: (_f: unknown, v: unknown) => ({ lt: v }),
  desc: () => ({ desc: true }),
  inArray: (_f: unknown, v: unknown) => ({ in: v }),
  isNull: () => ({ isNull: true }),
  sql: Object.assign(
    (s: TemplateStringsArray, ...v: unknown[]) => ({ s, v }),
    {},
  ),
}))
vi.mock("../src/integration-stripe/service", () => ({
  integrationStripeService: {
    credentialsByIntegrationId: (...a: unknown[]) => m.credentials(...a),
  },
}))
vi.mock("../src/integration-stripe/client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/integration-stripe/client")>()
  const real = new actual.Stripe(
    ["sk", "test", "unitTestKey0123456789"].join("_"),
  )
  return {
    ...actual,
    createStripeClient: () => ({
      webhooks: real.webhooks,
      invoices: { retrieve: (...a: unknown[]) => m.retrieve(...a) },
      invoicePayments: { list: (...a: unknown[]) => m.paymentsList(...a) },
      charges: { retrieve: (...a: unknown[]) => m.chargeRetrieve(...a) },
      checkout: {
        sessions: { retrieve: (...a: unknown[]) => m.sessionRetrieve(...a) },
      },
      paymentIntents: { retrieve: (...a: unknown[]) => m.piRetrieve(...a) },
    }),
  }
})
vi.mock("../src/invoice/contact-marks", () => ({
  markInvoiceOnContact: (...a: unknown[]) => m.marks(...a),
  markInvoiceCreated: vi.fn(),
}))
vi.mock("@chatbotx.io/events", () => ({
  emitInvoicePaid: (...a: unknown[]) => m.emitPaid(...a),
  emitInvoicePaymentFailed: (...a: unknown[]) => m.emitFailed(...a),
  emitInvoiceCreated: (...a: unknown[]) => m.emitCreated(...a),
}))
vi.mock("../src/audit/dispatcher", () => ({ dispatchAuditRecord: vi.fn() }))
vi.mock("../src/logger", () => ({
  logger: { warn: m.loggerWarn, error: m.loggerError, info: vi.fn() },
}))

const { handleStripeWebhook } = await import("../src/invoice/stripe-webhook")
const signer = new Stripe(["sk", "test", "unitTestKey0123456789"].join("_"))
  .webhooks

type EventInput = {
  id?: string
  type?: string
  livemode?: boolean
  object?: Record<string, unknown>
}

function eventBody(input: EventInput = {}): string {
  return JSON.stringify({
    id: input.id ?? "evt_1",
    object: "event",
    api_version: "2026-05-27.dahlia",
    created: Math.floor(Date.now() / 1000),
    livemode: input.livemode ?? false,
    type: input.type ?? "invoice.paid",
    data: {
      object: input.object ?? { id: STRIPE_INVOICE_ID, object: "invoice" },
    },
  })
}

function deliver(
  input: EventInput = {},
  options: {
    secret?: string
    timestamp?: number
    signature?: string | null
  } = {},
) {
  const payload = eventBody(input)
  const signature =
    options.signature === undefined
      ? signer.generateTestHeaderString({
          payload,
          secret: options.secret ?? SECRET,
          ...(options.timestamp ? { timestamp: options.timestamp } : {}),
        })
      : options.signature
  return handleStripeWebhook({
    integrationId: INTEGRATION_ID,
    rawBody: Buffer.from(payload),
    signature,
  })
}

const hubRow = (status: string) => ({
  id: HUB_ID,
  workspaceId: WORKSPACE_ID,
  contactId: "21",
  number: 3,
  status,
  method: "stripeInvoice",
  total: "10.00",
  currency: "USD",
  hostedUrl: "https://invoice.stripe.com/i/x",
  dealId: null,
  integrationId: INTEGRATION_ID,
  providerInvoiceId: STRIPE_INVOICE_ID,
})

const stripeInvoice = (status: string, hubId: string = HUB_ID) => ({
  id: STRIPE_INVOICE_ID,
  object: "invoice",
  status,
  metadata: { hub_invoice_id: hubId },
})

beforeEach(() => {
  m.chargeRetrieve.mockImplementation((id: string) =>
    Promise.resolve({ id, refunded: true, payment_intent: "pi_1" }),
  )
  vi.clearAllMocks()
  m.state.hubRow = hubRow("open")
  m.state.insertResult = [{ id: "ev-row" }]
  m.state.transitionMatches = true
  m.state.inserted = []
  m.state.updates = []
  m.state.deleteWheres = []
  m.state.transactionError = null
  m.credentials.mockResolvedValue({
    integrationId: INTEGRATION_ID,
    workspaceId: WORKSPACE_ID,
    livemode: false,
    auth: {
      secretKey: ["sk", "test", "unitTestKey0123456789"].join("_"),
      webhookSecret: SECRET,
    },
  })
  m.retrieve.mockResolvedValue(stripeInvoice("paid"))
  m.marks.mockResolvedValue(undefined)
  m.emitPaid.mockResolvedValue(undefined)
  m.emitFailed.mockResolvedValue(undefined)
})

const expectNoSideEffects = () => {
  expect(m.marks).not.toHaveBeenCalled()
  expect(m.emitPaid).not.toHaveBeenCalled()
  expect(m.emitFailed).not.toHaveBeenCalled()
}

describe("handleStripeWebhook: routing and verification", () => {
  test.each([
    ["abc"],
    [""],
    ["12a"],
    ["-1"],
    ["123456789012345678901"],
    ["1 OR 1=1"],
  ])("a non-numeric integration id %j is unknown, no lookup", async (id) => {
    const result = await handleStripeWebhook({
      integrationId: id,
      rawBody: Buffer.from(eventBody()),
      signature: "t=1,v1=x",
    })
    expect(result.outcome).toBe("unknown")
    expect(m.credentials).not.toHaveBeenCalled()
  })

  test("an unknown integration is unknown", async () => {
    m.credentials.mockResolvedValue(null)
    expect((await deliver()).outcome).toBe("unknown")
    expect(m.state.inserted).toEqual([])
  })

  test("unreadable credentials (decrypt throws) ask Stripe to retry", async () => {
    m.credentials.mockRejectedValue(new Error("bad ciphertext"))
    expect((await deliver()).outcome).toBe("retry")
  })

  test.each([
    [null],
    [""],
  ])("a missing signature %j is rejected", async (sig) => {
    const result = await deliver({}, { signature: sig })
    expect(result).toEqual({ outcome: "rejected", detail: "missing signature" })
    expect(m.retrieve).not.toHaveBeenCalled()
  })

  test("a signature from another secret is rejected", async () => {
    const result = await deliver(
      {},
      { secret: "whsec_someoneElse0123456789abcdef" },
    )
    expect(result).toEqual({ outcome: "rejected", detail: "bad signature" })
    expect(m.state.inserted).toEqual([])
    expectNoSideEffects()
  })

  test("a garbage signature header is rejected", async () => {
    const result = await deliver({}, { signature: "t=1,v1=deadbeef" })
    expect(result.outcome).toBe("rejected")
  })

  test("a tampered body (signed body != sent body) is rejected", async () => {
    const payload = eventBody()
    const signature = signer.generateTestHeaderString({
      payload,
      secret: SECRET,
    })
    const result = await handleStripeWebhook({
      integrationId: INTEGRATION_ID,
      rawBody: Buffer.from(payload.replace("evt_1", "evt_2")),
      signature,
    })
    expect(result.outcome).toBe("rejected")
  })

  test("a stale timestamp (> 300 s) is rejected; 290 s is accepted", async () => {
    const now = Math.floor(Date.now() / 1000)
    expect((await deliver({}, { timestamp: now - 301 })).outcome).toBe(
      "rejected",
    )
    expect(m.state.inserted).toEqual([])
    expect((await deliver({}, { timestamp: now - 290 })).outcome).toBe(
      "applied",
    )
  })

  test("a livemode mismatch is rejected before any write", async () => {
    const result = await deliver({ livemode: true })
    expect(result).toEqual({ outcome: "rejected", detail: "livemode mismatch" })
    expect(m.retrieve).not.toHaveBeenCalled()
    expect(m.state.inserted).toEqual([])
  })

  test("an unhandled event type is ignored, nothing written", async () => {
    const result = await deliver({ type: "customer.created" })
    expect(result).toEqual({ outcome: "ignored", detail: "customer.created" })
    expect(m.state.inserted).toEqual([])
    expect(m.retrieve).not.toHaveBeenCalled()
  })
})

describe("handleStripeWebhook: dedup, confirmation and the transition", () => {
  test("a duplicate event id (insert returns no row) is duplicate: no CAS, no marks, no emit", async () => {
    m.state.insertResult = []
    const result = await deliver()
    expect(result).toEqual({ outcome: "duplicate", detail: "evt_1" })
    expect(m.state.updates).toEqual([])
    expectNoSideEffects()
  })

  test("invoice.paid confirmed by Stripe: applied, marks(paid) + emitInvoicePaid once", async () => {
    const result = await deliver()
    expect(result.outcome).toBe("applied")
    expect(m.state.inserted).toEqual([
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        integrationId: INTEGRATION_ID,
        invoiceId: HUB_ID,
        providerEventId: "evt_1",
        type: "invoice.paid",
        outcome: "received",
      }),
    ])
    expect(m.state.updates).toHaveLength(1)
    expect(m.state.updates[0]).toMatchObject({ status: "paid" })
    expect(m.state.updates[0]?.paidAt).toBeInstanceOf(Date)
    expect(m.marks).toHaveBeenCalledTimes(1)
    expect(m.marks).toHaveBeenCalledWith({
      invoice: expect.objectContaining({ id: HUB_ID, status: "paid" }),
      status: "paid",
    })
    expect(m.emitPaid).toHaveBeenCalledTimes(1)
    expect(m.emitPaid).toHaveBeenCalledWith(
      WORKSPACE_ID,
      "21",
      expect.objectContaining({ invoiceId: HUB_ID, status: "paid" }),
    )
    expect(m.retrieve).toHaveBeenCalledWith(STRIPE_INVOICE_ID)
  })

  test("invoice.paid but Stripe says open: noop (unconfirmed), recorded, no CAS, no marks", async () => {
    m.retrieve.mockResolvedValue(stripeInvoice("open"))
    const result = await deliver()
    expect(result).toEqual({ outcome: "noop", detail: "unconfirmed" })
    expect(m.state.inserted[0]).toMatchObject({ outcome: "unconfirmed" })
    expect(m.state.updates).toEqual([])
    expectNoSideEffects()
  })

  test("a Stripe invoice whose metadata names another hub row is noop (unknown-invoice)", async () => {
    m.retrieve.mockResolvedValue(stripeInvoice("paid", "999"))
    const result = await deliver()
    expect(result).toEqual({ outcome: "noop", detail: "unknown-invoice" })
    expect(m.state.inserted[0]).toMatchObject({ invoiceId: null })
    expect(m.state.updates).toEqual([])
    expectNoSideEffects()
  })

  test("no hub row for the Stripe invoice is noop (unknown-invoice)", async () => {
    m.state.hubRow = null
    expect((await deliver()).detail).toBe("unknown-invoice")
    expectNoSideEffects()
  })

  test("payment_failed on an open invoice marks payment_failed and emits once", async () => {
    m.retrieve.mockResolvedValue(stripeInvoice("open"))
    const result = await deliver({ type: "invoice.payment_failed" })
    expect(result.outcome).toBe("noop")
    expect(m.state.updates).toEqual([])
    expect(m.marks).toHaveBeenCalledWith({
      invoice: expect.objectContaining({ id: HUB_ID }),
      status: "payment_failed",
    })
    expect(m.emitFailed).toHaveBeenCalledTimes(1)
    expect(m.emitPaid).not.toHaveBeenCalled()
  })

  test("payment_failed after paid (out of order) marks nothing", async () => {
    m.state.hubRow = hubRow("paid")
    m.retrieve.mockResolvedValue(stripeInvoice("paid"))
    const result = await deliver({ type: "invoice.payment_failed" })
    expect(result.outcome).toBe("noop")
    expectNoSideEffects()
  })

  test("payment_failed while Stripe already shows it paid marks nothing", async () => {
    m.retrieve.mockResolvedValue(stripeInvoice("paid"))
    await deliver({ type: "invoice.payment_failed" })
    expectNoSideEffects()
  })

  test("a CAS that matches no row (already moved) is noop, no marks", async () => {
    m.state.hubRow = hubRow("void")
    m.state.transitionMatches = false
    m.retrieve.mockResolvedValue(stripeInvoice("paid"))
    const result = await deliver()
    expect(result.outcome).toBe("noop")
    expectNoSideEffects()
  })

  test("invoice.voided confirmed: applied, marks(void), sets voidedAt", async () => {
    m.retrieve.mockResolvedValue(stripeInvoice("void"))
    const result = await deliver({ type: "invoice.voided" })
    expect(result.outcome).toBe("applied")
    expect(m.state.updates[0]).toMatchObject({ status: "void" })
    expect(m.state.updates[0]?.voidedAt).toBeInstanceOf(Date)
    expect(m.marks).toHaveBeenCalledWith({
      invoice: expect.objectContaining({ status: "void" }),
      status: "void",
    })
    expect(m.emitPaid).not.toHaveBeenCalled()
  })

  test("charge.refunded (full) resolves the invoice through invoicePayments and applies refunded", async () => {
    m.state.hubRow = hubRow("paid")
    m.paymentsList.mockResolvedValue({
      data: [{ invoice: STRIPE_INVOICE_ID }],
    })
    m.retrieve.mockResolvedValue(stripeInvoice("paid"))
    const result = await deliver({
      type: "charge.refunded",
      object: {
        id: "ch_1",
        object: "charge",
        refunded: true,
        payment_intent: "pi_1",
      },
    })
    expect(result.outcome).toBe("applied")
    expect(m.paymentsList).toHaveBeenCalledWith({
      payment: { type: "payment_intent", payment_intent: "pi_1" },
      limit: 1,
    })
    expect(m.state.updates[0]).toMatchObject({ status: "refunded" })
  })

  test("a PARTIAL refund is recorded only (no lookup, no transition)", async () => {
    m.state.hubRow = hubRow("paid")
    m.chargeRetrieve.mockResolvedValue({
      id: "ch_1",
      refunded: false,
      payment_intent: "pi_1",
    })
    const result = await deliver({
      type: "charge.refunded",
      object: {
        id: "ch_1",
        object: "charge",
        refunded: false,
        payment_intent: "pi_1",
      },
    })
    expect(result).toEqual({ outcome: "noop", detail: "unknown-invoice" })
    expect(m.paymentsList).not.toHaveBeenCalled()
    expect(m.state.updates).toEqual([])
  })
})

describe("handleStripeWebhook: failure paths", () => {
  test("marks throw: retry AND the dedup row delete is issued for this event", async () => {
    m.marks.mockRejectedValue(new Error("custom field write failed"))
    const result = await deliver({ id: "evt_marks" })
    expect(result).toEqual({ outcome: "retry", detail: "contact marks" })
    expect(m.state.deleteWheres).toHaveLength(1)
    expect(JSON.stringify(m.state.deleteWheres[0])).toContain("evt_marks")
    expect(JSON.stringify(m.state.deleteWheres[0])).toContain(INTEGRATION_ID)
    expect(m.emitPaid).not.toHaveBeenCalled()
  })

  test("the emit throws after marks: retry and the dedup row is deleted", async () => {
    m.emitPaid.mockRejectedValue(new Error("redis down"))
    const result = await deliver()
    expect(result.outcome).toBe("retry")
    expect(m.state.deleteWheres).toHaveLength(1)
  })

  test("the redelivery after a failed mark (row already paid) re-runs marks + emit", async () => {
    m.state.hubRow = hubRow("paid")
    m.state.transitionMatches = false
    const result = await deliver()
    expect(result.outcome).toBe("noop")
    expect(m.marks).toHaveBeenCalledWith({
      invoice: expect.objectContaining({ id: HUB_ID }),
      status: "paid",
    })
    expect(m.emitPaid).toHaveBeenCalledTimes(1)
  })

  // SOURCE BUG (reported): after a failed mark on a void/uncollectible/
  // refunded event the dedup row is deleted and the redelivery finds the row
  // already transitioned (CAS null), so `applied` is null and only the paid
  // branch re-runs marks: the contact never gets invoice_last_status=void.
  // Flip to `test` when stripe-webhook.ts re-runs marks for a confirmed
  // target the row already holds.
  test("the redelivery of a voided event after a failed mark re-runs marks(void)", async () => {
    m.state.hubRow = hubRow("void")
    m.state.transitionMatches = false
    m.retrieve.mockResolvedValue(stripeInvoice("void"))
    await deliver({ type: "invoice.voided" })
    expect(m.marks).toHaveBeenCalledWith({
      invoice: expect.objectContaining({ id: HUB_ID }),
      status: "void",
    })
  })

  test("a Stripe connection error on retrieve: retry, nothing written", async () => {
    m.retrieve.mockRejectedValue(
      new Stripe.errors.StripeConnectionError({ message: "ECONNRESET" }),
    )
    const result = await deliver()
    expect(result).toEqual({ outcome: "retry", detail: "stripe unreachable" })
    expect(m.state.inserted).toEqual([])
    expectNoSideEffects()
  })

  test("a FORGED refunded:true is not trusted: Stripe's own charge says not refunded -> no lookup, no transition", async () => {
    m.state.hubRow = hubRow("paid")
    m.chargeRetrieve.mockResolvedValue({
      id: "ch_1",
      refunded: false,
      payment_intent: "pi_1",
    })
    const result = await deliver({
      type: "charge.refunded",
      object: {
        id: "ch_1",
        object: "charge",
        refunded: true,
        payment_intent: "pi_1",
      },
    })
    expect(m.chargeRetrieve).toHaveBeenCalledWith("ch_1")
    expect(m.paymentsList).not.toHaveBeenCalled()
    expect(result.outcome).not.toBe("applied")
    expect(m.state.updates).toEqual([])
  })

  test("a Stripe rate limit on the refund lookup: retry", async () => {
    m.paymentsList.mockRejectedValue(
      new Stripe.errors.StripeRateLimitError({ message: "slow down" }),
    )
    const result = await deliver({
      type: "charge.refunded",
      object: {
        id: "ch_1",
        object: "charge",
        refunded: true,
        payment_intent: "pi_1",
      },
    })
    expect(result.outcome).toBe("retry")
  })

  test("a non-retryable Stripe error (404) is logged and recorded as unknown-invoice", async () => {
    m.retrieve.mockRejectedValue(
      new Stripe.errors.StripeInvalidRequestError({
        message: "No such invoice",
        statusCode: 404,
      } as never),
    )
    const result = await deliver()
    expect(result).toEqual({ outcome: "noop", detail: "unknown-invoice" })
    expect(m.loggerWarn).toHaveBeenCalled()
    expectNoSideEffects()
  })

  test("a database failure in the dedup transaction: retry, no marks", async () => {
    m.state.transactionError = new Error("connection terminated")
    const result = await deliver()
    expect(result).toEqual({ outcome: "retry", detail: "database" })
    expectNoSideEffects()
  })
})

describe("stripeCheckout (s207b): checkout.session.* and refunds", () => {
  const SESSION_ID = "cs_test_1"
  const checkoutRow = (
    status: string,
    extra: Record<string, unknown> = {},
  ) => ({
    ...hubRow(status),
    method: "stripeCheckout",
    providerInvoiceId: null,
    hostedUrl: "https://chat.example.org/pay/0123456789ABCDEFGHIJKL",
    ...extra,
  })
  const session = (extra: Record<string, unknown> = {}) => ({
    id: SESSION_ID,
    object: "checkout.session",
    status: "complete",
    payment_status: "paid",
    amount_total: 1000,
    currency: "usd",
    payment_intent: "pi_1",
    metadata: { hub_invoice_id: HUB_ID, hub_workspace_id: WORKSPACE_ID },
    ...extra,
  })
  const completed = (type = "checkout.session.completed", id = "evt_cs_1") =>
    deliver({
      id,
      type,
      object: { id: SESSION_ID, object: "checkout.session" },
    })

  beforeEach(() => {
    m.state.hubRow = checkoutRow("open")
    m.sessionRetrieve.mockResolvedValue(session())
    m.paymentsList.mockResolvedValue({ data: [] })
    m.piRetrieve.mockResolvedValue({
      id: "pi_1",
      metadata: { hub_invoice_id: HUB_ID, hub_workspace_id: WORKSPACE_ID },
    })
  })

  test("a paid session for the hub total marks paid, stores the PaymentIntent, marks and emits once", async () => {
    const result = await completed()
    expect(result.outcome).toBe("applied")
    expect(m.sessionRetrieve).toHaveBeenCalledWith(SESSION_ID)
    expect(m.retrieve).not.toHaveBeenCalled()
    expect(m.state.updates[0]).toMatchObject({
      status: "paid",
      providerInvoiceId: "pi_1",
      paidAt: expect.any(Date),
    })
    expect(m.marks).toHaveBeenCalledWith({
      invoice: expect.objectContaining({ id: HUB_ID, status: "paid" }),
      status: "paid",
    })
    expect(m.emitPaid).toHaveBeenCalledTimes(1)
  })

  test("async_payment_succeeded settles the same way", async () => {
    const result = await completed("checkout.session.async_payment_succeeded")
    expect(result.outcome).toBe("applied")
    expect(m.emitPaid).toHaveBeenCalledTimes(1)
  })

  test.each([
    ["an unpaid session (async payment pending)", { payment_status: "unpaid" }],
    ["a different amount", { amount_total: 999 }],
    ["a different currency", { currency: "eur" }],
    ["no amount", { amount_total: null }],
    ["no PaymentIntent", { payment_intent: null }],
  ])("%s is recorded unconfirmed: no transition, no marks", async (_label, extra) => {
    m.sessionRetrieve.mockResolvedValue(session(extra))
    const result = await completed()
    expect(result).toEqual({ outcome: "noop", detail: "unconfirmed" })
    expect(m.state.inserted[0]).toMatchObject({ outcome: "unconfirmed" })
    expect(m.state.updates).toEqual([])
    expectNoSideEffects()
  })

  test("an amount mismatch on a PAID session is logged loudly", async () => {
    m.sessionRetrieve.mockResolvedValue(session({ amount_total: 1 }))
    await completed()
    expect(m.loggerError).toHaveBeenCalled()
  })

  test.each([
    ["another workspace", { hub_invoice_id: HUB_ID, hub_workspace_id: "999" }],
    ["no hub id", { hub_workspace_id: WORKSPACE_ID }],
    [
      "a non-numeric hub id",
      { hub_invoice_id: "1 OR 1=1", hub_workspace_id: WORKSPACE_ID },
    ],
    ["no metadata", null],
  ])("session metadata naming %s resolves to no invoice", async (_label, metadata) => {
    m.sessionRetrieve.mockResolvedValue(session({ metadata }))
    const result = await completed()
    expect(result).toEqual({ outcome: "noop", detail: "unknown-invoice" })
    expect(m.state.updates).toEqual([])
    expectNoSideEffects()
  })

  test("a SECOND payment on a paid invoice is never applied: flagged on the event and in lastError", async () => {
    m.state.hubRow = checkoutRow("paid", { providerInvoiceId: "pi_first" })
    m.state.transitionMatches = false
    const result = await completed()
    expect(result).toEqual({ outcome: "noop", detail: "duplicate-payment" })
    expect(m.state.updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outcome: "duplicate-payment" }),
        expect.objectContaining({
          lastError: expect.stringContaining("pi_1"),
        }),
      ]),
    )
    expect(m.loggerError).toHaveBeenCalled()
    expectNoSideEffects()
  })

  test("a payment on a VOID invoice is flagged the same way", async () => {
    m.state.hubRow = checkoutRow("void")
    m.state.transitionMatches = false
    const result = await completed()
    expect(result.detail).toBe("duplicate-payment")
    expectNoSideEffects()
  })

  test("a redelivery of the RECORDED payment (after a failed mark) re-runs the marks", async () => {
    m.state.hubRow = checkoutRow("paid", { providerInvoiceId: "pi_1" })
    m.state.transitionMatches = false
    const result = await completed()
    expect(result.outcome).toBe("noop")
    expect(m.marks).toHaveBeenCalledTimes(1)
    expect(m.emitPaid).toHaveBeenCalledTimes(1)
  })

  test("async_payment_failed on an open invoice marks payment_failed", async () => {
    m.sessionRetrieve.mockResolvedValue(session({ payment_status: "unpaid" }))
    await completed("checkout.session.async_payment_failed")
    expect(m.marks).toHaveBeenCalledWith({
      invoice: expect.objectContaining({ id: HUB_ID }),
      status: "payment_failed",
    })
    expect(m.emitFailed).toHaveBeenCalledTimes(1)
    expect(m.state.updates).toEqual([])
  })

  test("a duplicate event id is a duplicate: nothing re-applied", async () => {
    m.state.insertResult = []
    const result = await completed()
    expect(result.outcome).toBe("duplicate")
    expectNoSideEffects()
  })

  test("Stripe unreachable while re-reading the session asks for a retry", async () => {
    m.sessionRetrieve.mockRejectedValue(
      new Stripe.errors.StripeConnectionError({ message: "down" }),
    )
    const result = await completed()
    expect(result).toEqual({ outcome: "retry", detail: "stripe unreachable" })
    expect(m.state.inserted).toEqual([])
  })

  test("a full refund of a checkout payment resolves through the PaymentIntent metadata", async () => {
    m.state.hubRow = checkoutRow("paid", { providerInvoiceId: "pi_1" })
    const result = await deliver({
      id: "evt_ref_1",
      type: "charge.refunded",
      object: { id: "ch_1", object: "charge" },
    })
    expect(result.outcome).toBe("applied")
    expect(m.retrieve).not.toHaveBeenCalled()
    expect(m.piRetrieve).toHaveBeenCalledWith("pi_1")
    expect(m.state.updates[0]).toMatchObject({ status: "refunded" })
  })

  test("a refund whose PaymentIntent is not the one the invoice recorded is not applied", async () => {
    m.state.hubRow = checkoutRow("paid", { providerInvoiceId: "pi_other" })
    const result = await deliver({
      id: "evt_ref_2",
      type: "charge.refunded",
      object: { id: "ch_1", object: "charge" },
    })
    expect(result).toEqual({ outcome: "noop", detail: "unknown-invoice" })
    expect(m.state.updates).toEqual([])
  })

  test("a PARTIAL refund of a checkout payment moves nothing", async () => {
    m.state.hubRow = checkoutRow("paid", { providerInvoiceId: "pi_1" })
    m.chargeRetrieve.mockResolvedValue({
      id: "ch_1",
      refunded: false,
      payment_intent: "pi_1",
    })
    const result = await deliver({
      id: "evt_ref_3",
      type: "charge.refunded",
      object: { id: "ch_1", object: "charge" },
    })
    expect(result.outcome).toBe("noop")
    expect(m.piRetrieve).not.toHaveBeenCalled()
  })
})
