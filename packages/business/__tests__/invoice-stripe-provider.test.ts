import { beforeEach, describe, expect, test, vi } from "vitest"

/**
 * finalizeWithStripe's collection choice (s206b). Stripe refuses
 * `send_invoice` for a customer without an email, so an email-less customer
 * gets `charge_automatically` (never charged on its own: auto_advance false)
 * under its OWN Idempotency-Key, and a resumed invoice never re-chooses. A
 * Stripe invoice whose id never reached the row (crash before the persist) is
 * adopted by its `hub_invoice_id` metadata instead of minting a twin.
 * The database is mocked at the query-builder seam; the Stripe client is a
 * fake whose calls are recorded.
 */

const INVOICE_ID = "901"
const CUSTOMER = "cus_test_1"

const m = vi.hoisted(() => {
  const stripe = {
    customers: { retrieve: vi.fn(), create: vi.fn() },
    invoices: {
      create: vi.fn(),
      retrieve: vi.fn(),
      finalizeInvoice: vi.fn(),
      listLineItems: vi.fn(),
      list: vi.fn(),
      voidInvoice: vi.fn(),
      del: vi.fn(),
    },
    invoiceItems: { create: vi.fn() },
  }
  /** Every `.set(...)` payload written to the invoice row. */
  const written: Record<string, unknown>[] = []
  /** Every `.where(...)` predicate of those UPDATEs. */
  const predicates: unknown[] = []
  /** Rows the persist UPDATE returns: [] = another finalize won. */
  const updateRows = { value: [{ id: "901" }] as unknown[] }
  const db = {
    query: {
      stripeCustomerModel: {
        findFirst: vi.fn(async () => ({ customerId: "cus_test_1" })),
      },
      invoiceModel: { findFirst: vi.fn() },
    },
    update: vi.fn(() => ({
      set: (values: Record<string, unknown>) => {
        written.push(values)
        return {
          where: (predicate: unknown) => {
            predicates.push(predicate)
            return { returning: async () => updateRows.value }
          },
        }
      },
    })),
  }
  return { stripe, db, written, predicates, updateRows }
})

vi.mock("@chatbotx.io/database/client", () => ({
  db: m.db,
  and: (...c: unknown[]) => ({ and: c }),
  eq: (_f: unknown, v: unknown) => ({ eq: v }),
  isNull: () => ({ isNull: true }),
}))
vi.mock("../src/integration-stripe/client", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/integration-stripe/client")
  >()),
  createStripeClient: () => m.stripe,
}))
vi.mock("../src/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

const { finalizeWithStripe, InvoiceProviderError } = await import(
  "../src/invoice/stripe-provider"
)
const { Stripe } = await import("../src/integration-stripe/client")

const CREDENTIALS = {
  integrationId: "77",
  accountId: "acct_test",
  auth: { secretKey: ["sk", "test", "x"].join("_") },
} as never

const createdAt = new Date("2026-09-26T12:00:00Z")
const invoice = (over: Record<string, unknown> = {}) =>
  ({
    id: INVOICE_ID,
    workspaceId: "11",
    contactId: "21",
    number: 3,
    currency: "USD",
    total: "1.00",
    memo: null,
    createdAt,
    dueAt: new Date("2026-10-03T12:00:00Z"),
    providerInvoiceId: null,
    ...over,
  }) as never

const LINES = [
  { position: 0, description: "line", quantity: 1, unitAmount: "1.00" },
] as never

const openInvoice = {
  id: "in_1",
  status: "open",
  total: 100,
  currency: "usd",
  hosted_invoice_url: "https://invoice.stripe.com/i/x",
  invoice_pdf: null,
  due_date: null,
}

const RETRIEVE_CUSTOMER_ERROR = /^Stripe retrieve customer:/

// An auto-pager over these items (Stripe list results are async-iterable).
const pager = (items: unknown[]) => items[Symbol.iterator]()
const noLines = () => pager([])
const listed = (items: Record<string, unknown>[]) =>
  m.stripe.invoices.list.mockImplementation(() => pager(items))
const ours = { hub_invoice_id: INVOICE_ID, hub_workspace_id: "11" }

beforeEach(() => {
  vi.clearAllMocks()
  m.written.length = 0
  m.predicates.length = 0
  m.updateRows.value = [{ id: INVOICE_ID }]
  m.stripe.invoices.create.mockResolvedValue({ id: "in_1" })
  listed([])
  m.stripe.invoices.retrieve.mockResolvedValue({
    ...openInvoice,
    status: "draft",
  })
  m.stripe.invoices.listLineItems.mockImplementation(noLines)
  m.stripe.invoiceItems.create.mockResolvedValue({})
  m.stripe.invoices.finalizeInvoice.mockResolvedValue(openInvoice)
})

describe("finalizeWithStripe collection choice", () => {
  test("a customer WITH an email: send_invoice, days_until_due, the original key", async () => {
    m.stripe.customers.retrieve.mockResolvedValue({
      id: CUSTOMER,
      email: "a@b.test",
    })
    await finalizeWithStripe({
      credentials: CREDENTIALS,
      invoice: invoice(),
      lines: LINES,
    })
    const [params, opts] = m.stripe.invoices.create.mock.calls[0] ?? []
    expect(params).toMatchObject({
      collection_method: "send_invoice",
      days_until_due: 7,
      auto_advance: false,
    })
    expect(opts).toEqual({ idempotencyKey: `hub-inv-${INVOICE_ID}-create` })
    expect(m.stripe.invoices.finalizeInvoice.mock.calls[0]?.[1]).toEqual({
      auto_advance: false,
    })
  })

  test("a customer WITHOUT an email: charge_automatically, no days_until_due, its own key, never auto-advanced", async () => {
    m.stripe.customers.retrieve.mockResolvedValue({ id: CUSTOMER, email: null })
    const result = await finalizeWithStripe({
      credentials: CREDENTIALS,
      invoice: invoice(),
      lines: LINES,
    })
    const [params, opts] = m.stripe.invoices.create.mock.calls[0] ?? []
    expect(params).toMatchObject({
      collection_method: "charge_automatically",
      auto_advance: false,
    })
    expect(params).not.toHaveProperty("days_until_due")
    expect(opts).toEqual({
      idempotencyKey: `hub-inv-${INVOICE_ID}-create-charge`,
    })
    expect(m.stripe.invoices.finalizeInvoice.mock.calls[0]?.[1]).toEqual({
      auto_advance: false,
    })
    expect(result).toMatchObject({
      status: "open",
      hostedUrl: openInvoice.hosted_invoice_url,
      dueAt: null,
    })
  })

  test("an empty-string email counts as no email", async () => {
    m.stripe.customers.retrieve.mockResolvedValue({ id: CUSTOMER, email: "" })
    await finalizeWithStripe({
      credentials: CREDENTIALS,
      invoice: invoice(),
      lines: LINES,
    })
    expect(m.stripe.invoices.create.mock.calls[0]?.[0]).toMatchObject({
      collection_method: "charge_automatically",
    })
  })

  test("a resumed invoice (Stripe id already stored) never re-reads the customer or creates again", async () => {
    await finalizeWithStripe({
      credentials: CREDENTIALS,
      invoice: invoice({ providerInvoiceId: "in_1" }),
      lines: LINES,
    })
    expect(m.stripe.customers.retrieve).not.toHaveBeenCalled()
    expect(m.stripe.invoices.create).not.toHaveBeenCalled()
  })

  test("a customer deleted in Stripe is a non-retryable error before any invoice create", async () => {
    m.stripe.customers.retrieve.mockResolvedValue({
      id: CUSTOMER,
      deleted: true,
    })
    const error = await finalizeWithStripe({
      credentials: CREDENTIALS,
      invoice: invoice(),
      lines: LINES,
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(InvoiceProviderError)
    expect((error as InstanceType<typeof InvoiceProviderError>).retryable).toBe(
      false,
    )
    expect(m.stripe.invoices.create).not.toHaveBeenCalled()
  })

  test("a network failure reading the customer is retryable and creates nothing", async () => {
    m.stripe.customers.retrieve.mockRejectedValue(
      new Stripe.errors.StripeConnectionError({
        message: "socket hang up",
      } as never),
    )
    const error = await finalizeWithStripe({
      credentials: CREDENTIALS,
      invoice: invoice(),
      lines: LINES,
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(InvoiceProviderError)
    expect((error as InstanceType<typeof InvoiceProviderError>).retryable).toBe(
      true,
    )
    expect((error as Error).message).toMatch(RETRIEVE_CUSTOMER_ERROR)
    expect(m.stripe.invoices.create).not.toHaveBeenCalled()
  })

  test("a new Stripe invoice's ids are persisted on the row", async () => {
    m.stripe.customers.retrieve.mockResolvedValue({ id: CUSTOMER, email: null })
    await finalizeWithStripe({
      credentials: CREDENTIALS,
      invoice: invoice(),
      lines: LINES,
    })
    expect(m.written).toEqual([
      expect.objectContaining({
        providerInvoiceId: "in_1",
        providerAccountId: "acct_test",
        providerCustomerId: CUSTOMER,
      }),
    ])
    // Only a still-DRAFT row without a Stripe id takes it (a void wins).
    expect(m.predicates).toEqual([
      { and: [{ eq: INVOICE_ID }, { eq: "draft" }, { isNull: true }] },
    ])
  })

  test("a Stripe invoice created before a crash is ADOPTED by metadata: no second create, even after the email changed", async () => {
    m.stripe.customers.retrieve.mockResolvedValue({
      id: CUSTOMER,
      email: "new@b.test",
    })
    listed([
      {
        id: "in_other",
        status: "open",
        metadata: { ...ours, hub_invoice_id: "902" },
      },
      { id: "in_orphan", status: "draft", metadata: ours },
    ])
    const result = await finalizeWithStripe({
      credentials: CREDENTIALS,
      invoice: invoice(),
      lines: LINES,
    })
    expect(m.stripe.invoices.list).toHaveBeenCalledWith({
      customer: CUSTOMER,
      created: { gte: Math.floor(createdAt.getTime() / 1000) - 60 },
      limit: 100,
    })
    expect(m.stripe.invoices.create).not.toHaveBeenCalled()
    expect(m.stripe.customers.retrieve).not.toHaveBeenCalled()
    expect(m.written).toEqual([
      expect.objectContaining({
        providerInvoiceId: "in_orphan",
        providerAccountId: "acct_test",
        providerCustomerId: CUSTOMER,
      }),
    ])
    expect(result.providerInvoiceId).toBe("in_orphan")
  })

  test("a candidate of ANOTHER workspace, or a VOIDED one, is never adopted: a new invoice is created", async () => {
    m.stripe.customers.retrieve.mockResolvedValue({ id: CUSTOMER, email: null })
    listed([
      {
        id: "in_foreign",
        status: "open",
        metadata: { ...ours, hub_workspace_id: "99" },
      },
      { id: "in_void", status: "void", metadata: ours },
    ])
    const result = await finalizeWithStripe({
      credentials: CREDENTIALS,
      invoice: invoice(),
      lines: LINES,
    })
    expect(m.stripe.invoices.create).toHaveBeenCalledTimes(1)
    expect(result.providerInvoiceId).toBe("in_1")
  })

  test("an adopted PAID invoice whose total disagrees is never voided: the finalize fails loud", async () => {
    listed([{ id: "in_paid", status: "paid", metadata: ours }])
    m.stripe.invoices.retrieve.mockResolvedValue({
      ...openInvoice,
      id: "in_paid",
      status: "paid",
      total: 999,
    })
    const error = await finalizeWithStripe({
      credentials: CREDENTIALS,
      invoice: invoice(),
      lines: LINES,
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(InvoiceProviderError)
    expect(m.stripe.invoices.voidInvoice).not.toHaveBeenCalled()
    expect(m.stripe.invoices.finalizeInvoice).not.toHaveBeenCalled()
  })

  test("past the scan cap the lookup fails non-retryable instead of creating", async () => {
    listed(
      Array.from({ length: 1000 }, (_, i) => ({
        id: `in_${i}`,
        status: "open",
        metadata: {},
      })),
    )
    const error = await finalizeWithStripe({
      credentials: CREDENTIALS,
      invoice: invoice(),
      lines: LINES,
    }).catch((e: unknown) => e)
    expect((error as InstanceType<typeof InvoiceProviderError>).retryable).toBe(
      false,
    )
    expect(m.stripe.invoices.create).not.toHaveBeenCalled()
  })

  test("a failure listing the customer's invoices is retryable and creates nothing", async () => {
    m.stripe.invoices.list.mockImplementation(() => {
      throw new Stripe.errors.StripeConnectionError({
        message: "socket hang up",
      } as never)
    })
    const error = await finalizeWithStripe({
      credentials: CREDENTIALS,
      invoice: invoice(),
      lines: LINES,
    }).catch((e: unknown) => e)
    expect((error as InstanceType<typeof InvoiceProviderError>).retryable).toBe(
      true,
    )
    expect(m.stripe.invoices.create).not.toHaveBeenCalled()
  })

  test("a concurrent finalize that won: the loser deletes ITS new draft and continues on the recorded invoice", async () => {
    m.stripe.customers.retrieve.mockResolvedValue({ id: CUSTOMER, email: null })
    m.stripe.invoices.create.mockResolvedValue({ id: "in_twin" })
    m.updateRows.value = []
    m.db.query.invoiceModel.findFirst.mockResolvedValue({
      providerInvoiceId: "in_winner",
    })
    const result = await finalizeWithStripe({
      credentials: CREDENTIALS,
      invoice: invoice(),
      lines: LINES,
    })
    expect(m.stripe.invoices.del).toHaveBeenCalledWith("in_twin")
    expect(m.stripe.invoices.retrieve).toHaveBeenCalledWith("in_winner")
    expect(result.providerInvoiceId).toBe("in_winner")
  })

  test("losing the race with an ADOPTED invoice never deletes it (it may be the other racer's)", async () => {
    listed([{ id: "in_orphan", status: "draft", metadata: ours }])
    m.updateRows.value = []
    m.db.query.invoiceModel.findFirst.mockResolvedValue({
      providerInvoiceId: "in_winner",
    })
    const result = await finalizeWithStripe({
      credentials: CREDENTIALS,
      invoice: invoice(),
      lines: LINES,
    })
    expect(m.stripe.invoices.del).not.toHaveBeenCalled()
    expect(result.providerInvoiceId).toBe("in_winner")
  })

  test("a row VOIDED during the finalize: our new draft is deleted and nothing is finalized", async () => {
    m.stripe.customers.retrieve.mockResolvedValue({ id: CUSTOMER, email: null })
    m.updateRows.value = []
    m.db.query.invoiceModel.findFirst.mockResolvedValue({
      providerInvoiceId: null,
    })
    const error = await finalizeWithStripe({
      credentials: CREDENTIALS,
      invoice: invoice(),
      lines: LINES,
    }).catch((e: unknown) => e)
    expect((error as InstanceType<typeof InvoiceProviderError>).retryable).toBe(
      false,
    )
    expect(m.stripe.invoices.del).toHaveBeenCalledWith("in_1")
    expect(m.stripe.invoiceItems.create).not.toHaveBeenCalled()
    expect(m.stripe.invoices.finalizeInvoice).not.toHaveBeenCalled()
  })
})
