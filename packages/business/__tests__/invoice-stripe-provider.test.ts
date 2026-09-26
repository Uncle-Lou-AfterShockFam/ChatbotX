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
    },
    invoiceItems: { create: vi.fn() },
  }
  const updateWhere = vi.fn()
  const db = {
    query: {
      stripeCustomerModel: {
        findFirst: vi.fn(async () => ({ customerId: "cus_test_1" })),
      },
    },
    update: vi.fn(() => ({ set: () => ({ where: updateWhere }) })),
  }
  return { stripe, db, updateWhere }
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

// A Stripe draft with no line items yet: an empty auto-pager.
const noLines = () => [][Symbol.iterator]()

beforeEach(() => {
  vi.clearAllMocks()
  m.stripe.invoices.create.mockResolvedValue({ id: "in_1" })
  m.stripe.invoices.list.mockResolvedValue({ data: [] })
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

  test("a Stripe invoice created before a crash is ADOPTED by metadata: no second create, even after the email changed", async () => {
    m.stripe.customers.retrieve.mockResolvedValue({
      id: CUSTOMER,
      email: "new@b.test",
    })
    m.stripe.invoices.list.mockResolvedValue({
      data: [
        { id: "in_other", status: "open", metadata: { hub_invoice_id: "902" } },
        {
          id: "in_orphan",
          status: "draft",
          metadata: { hub_invoice_id: INVOICE_ID },
        },
      ],
    })
    const result = await finalizeWithStripe({
      credentials: CREDENTIALS,
      invoice: invoice(),
      lines: LINES,
    })
    expect(m.stripe.invoices.list).toHaveBeenCalledWith({
      customer: CUSTOMER,
      limit: 100,
    })
    expect(m.stripe.invoices.create).not.toHaveBeenCalled()
    expect(m.stripe.customers.retrieve).not.toHaveBeenCalled()
    expect(m.stripe.invoices.retrieve).toHaveBeenCalledWith("in_orphan")
    expect(m.db.update).toHaveBeenCalledTimes(1)
    expect(result.providerInvoiceId).toBe("in_orphan")
  })

  test("a VOIDED Stripe invoice for this hub invoice is never adopted: a new one is created", async () => {
    m.stripe.customers.retrieve.mockResolvedValue({ id: CUSTOMER, email: null })
    m.stripe.invoices.list.mockResolvedValue({
      data: [
        {
          id: "in_void",
          status: "void",
          metadata: { hub_invoice_id: INVOICE_ID },
        },
      ],
    })
    await finalizeWithStripe({
      credentials: CREDENTIALS,
      invoice: invoice(),
      lines: LINES,
    })
    expect(m.stripe.invoices.create).toHaveBeenCalledTimes(1)
  })

  test("a failure listing the customer's invoices is retryable and creates nothing", async () => {
    m.stripe.invoices.list.mockRejectedValue(
      new Stripe.errors.StripeConnectionError({
        message: "socket hang up",
      } as never),
    )
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
})
