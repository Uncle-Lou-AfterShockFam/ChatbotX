import { beforeEach, describe, expect, test, vi } from "vitest"

/**
 * markInvoiceCreated (s212b): the latest invoice's link, PDF link, id and
 * status land on the contact, keyed by field name (no custom field ids here).
 */

const m = vi.hoisted(() => ({
  resolve: vi.fn(),
  setValue: vi.fn(),
  findValue: vi.fn(),
  attach: vi.fn(),
  /** The row status the post-write re-read sees (null = row gone). */
  rowStatus: { value: "open" as string | null },
}))

vi.mock("@chatbotx.io/database/client", () => {
  const chain: Record<string, unknown> = {}
  chain.from = () => chain
  chain.where = () => chain
  chain.limit = () =>
    Promise.resolve(
      m.rowStatus.value === null ? [] : [{ status: m.rowStatus.value }],
    )
  return { db: { select: () => chain }, eq: () => ({}) }
})

vi.mock("../src/custom-field/service", () => ({
  customFieldService: {
    resolveByNameAndType: (...a: unknown[]) => m.resolve(...a),
  },
}))
vi.mock("../src/contact-custom-field/service", () => ({
  contactCustomFieldService: {
    setValueByKey: (...a: unknown[]) => m.setValue(...a),
    findValue: (...a: unknown[]) => m.findValue(...a),
  },
}))
vi.mock("../src/tag/service", () => ({
  tagService: { attachByNamesToContacts: (...a: unknown[]) => m.attach(...a) },
}))

const { markInvoiceCreated, markInvoiceOnContact, markInvoiceStatusOnContact } =
  await import("../src/invoice/contact-marks")

const invoice = (over: Record<string, unknown> = {}) =>
  ({
    id: "900",
    workspaceId: "11",
    contactId: "22",
    status: "open",
    method: "stripeInvoice",
    hostedUrl: "https://invoice.stripe.com/i/x",
    pdfUrl: "https://pay.stripe.com/invoice/x/pdf",
    ...over,
  }) as never

const KEYWORD_NAMES: Record<string, string> = {
  "cf-last-id": "invoice_last_id",
}

/** field name -> value, from every setValueByKey call. */
const written = () =>
  Object.fromEntries(
    m.setValue.mock.calls.map(([arg]) => [
      KEYWORD_NAMES[(arg as { keyword: string }).keyword] ??
        (arg as { keyword: string }).keyword,
      (arg as { value: string }).value,
    ]),
  )

beforeEach(() => {
  vi.clearAllMocks()
  m.resolve.mockResolvedValue({
    idMap: new Map([["shortText:invoice_last_id", "cf-last-id"]]),
  })
  m.findValue.mockResolvedValue("900")
  m.setValue.mockResolvedValue(undefined)
  m.rowStatus.value = "open"
})

describe("markInvoiceCreated", () => {
  test("stripeInvoice: pay link, Stripe's PDF, id, status; the inbox rides every write", async () => {
    await markInvoiceCreated({ invoice: invoice(), contactInboxId: "ci-1" })
    expect(written()).toEqual({
      invoice_link: "https://invoice.stripe.com/i/x",
      invoice_pdf_link: "https://pay.stripe.com/invoice/x/pdf",
      invoice_last_id: "900",
      invoice_last_status: "open",
    })
    for (const [arg] of m.setValue.mock.calls) {
      expect(arg).toMatchObject({
        workspaceId: "11",
        contactId: "22",
        contactInboxId: "ci-1",
      })
    }
  })

  test("stripeCheckout: the hub /pay/<t>/pdf (the receipt once paid)", async () => {
    await markInvoiceCreated({
      invoice: invoice({
        method: "stripeCheckout",
        hostedUrl: "https://hub.example/pay/tok",
        pdfUrl: null,
      }),
    })
    expect(written()).toMatchObject({
      invoice_link: "https://hub.example/pay/tok",
      invoice_pdf_link: "https://hub.example/pay/tok/pdf",
    })
  })

  test('a woocommerce invoice with no stored PDF (opened before s213b) and a missing link write "", never "null"', async () => {
    await markInvoiceCreated({
      invoice: invoice({
        method: "woocommerce",
        hostedUrl: null,
        pdfUrl: null,
      }),
    })
    expect(written()).toMatchObject({ invoice_link: "", invoice_pdf_link: "" })
    expect(m.setValue.mock.calls[0]?.[0]).toMatchObject({
      contactInboxId: undefined,
    })
  })

  test("a webhook that paid the row during the write wins: the status is written again from the row (s212b review)", async () => {
    m.rowStatus.value = "paid"
    await markInvoiceCreated({ invoice: invoice(), contactInboxId: "ci-1" })
    const statusWrites = m.setValue.mock.calls
      .map(([arg]) => arg as { keyword: string; value: string })
      .filter((arg) => arg.keyword === "invoice_last_status")
      .map((arg) => arg.value)
    expect(statusWrites).toEqual(["open", "paid"])
  })

  test("no rewrite once a NEWER invoice owns the contact: its id must never carry this invoice's status", async () => {
    m.rowStatus.value = "paid"
    m.findValue.mockResolvedValue("901")
    await markInvoiceCreated({ invoice: invoice() })
    expect(m.findValue).toHaveBeenCalledWith({
      contactId: "22",
      customFieldId: "cf-last-id",
    })
    expect(m.setValue).toHaveBeenCalledTimes(4)
  })

  test("an unmoved row (or a missing one) is not written twice", async () => {
    await markInvoiceCreated({ invoice: invoice() })
    expect(m.setValue).toHaveBeenCalledTimes(4)
    m.setValue.mockClear()
    m.rowStatus.value = null
    await markInvoiceCreated({ invoice: invoice() })
    expect(m.setValue).toHaveBeenCalledTimes(4)
  })

  test("every field is created as shortText", async () => {
    await markInvoiceCreated({ invoice: invoice() })
    expect(m.resolve).toHaveBeenCalledWith({
      workspaceId: "11",
      fields: [
        { name: "invoice_link", type: "shortText" },
        { name: "invoice_pdf_link", type: "shortText" },
        { name: "invoice_last_id", type: "shortText" },
        { name: "invoice_last_status", type: "shortText" },
      ],
    })
  })
})

describe("webhook status marks follow the contact's LATEST invoice (s237)", () => {
  test("the latest invoice paid: status, paid id and tag", async () => {
    await markInvoiceOnContact({ invoice: invoice(), status: "paid" })
    expect(written()).toEqual({
      invoice_last_status: "paid",
      invoice_paid_id: "900",
    })
    expect(m.attach).toHaveBeenCalledTimes(1)
  })

  test("an OLDER invoice paid while a newer one is open: paid id + tag, never the status", async () => {
    m.findValue.mockResolvedValue("901")
    await markInvoiceOnContact({ invoice: invoice(), status: "paid" })
    expect(written()).toEqual({ invoice_paid_id: "900" })
    expect(m.attach).toHaveBeenCalledTimes(1)
  })

  test("an older invoice's deposit: deposit id only", async () => {
    m.findValue.mockResolvedValue("901")
    await markInvoiceOnContact({ invoice: invoice(), status: "partiallyPaid" })
    expect(written()).toEqual({ invoice_deposit_paid_id: "900" })
  })

  test("an older invoice's failed payment writes nothing", async () => {
    m.findValue.mockResolvedValue("901")
    await markInvoiceOnContact({ invoice: invoice(), status: "payment_failed" })
    expect(m.setValue).not.toHaveBeenCalled()
    expect(m.attach).not.toHaveBeenCalled()
  })

  test("no invoice_last_id field resolved: the status is not written", async () => {
    m.resolve.mockResolvedValue({ idMap: new Map() })
    await markInvoiceOnContact({ invoice: invoice(), status: "payment_failed" })
    expect(m.setValue).not.toHaveBeenCalled()
  })

  test("a refund rollback of the latest writes its status; of an older one, nothing", async () => {
    await markInvoiceStatusOnContact({
      invoice: invoice({ status: "partiallyPaid" }),
    })
    expect(written()).toEqual({ invoice_last_status: "partiallyPaid" })
    vi.clearAllMocks()
    m.findValue.mockResolvedValue("901")
    await markInvoiceStatusOnContact({ invoice: invoice({ status: "open" }) })
    expect(m.setValue).not.toHaveBeenCalled()
  })
})

describe("a newer invoice created between the latest check and the status write (s237 review)", () => {
  test("the newer invoice's row status is written back after the stale write", async () => {
    m.findValue.mockReset()
    // Check sees this invoice; the re-read after the write sees the newer one.
    m.findValue.mockResolvedValueOnce("900").mockResolvedValueOnce("901")
    m.rowStatus.value = "open"
    await markInvoiceOnContact({ invoice: invoice(), status: "paid" })
    const statuses = m.setValue.mock.calls
      .map(([arg]) => arg as { keyword: string; value: string })
      .filter((a) => a.keyword === "invoice_last_status")
      .map((a) => a.value)
    expect(statuses).toEqual(["paid", "open"])
    expect(written().invoice_paid_id).toBe("900")
  })

  test("the newer invoice's row is gone: no repair write", async () => {
    m.findValue.mockReset()
    m.findValue.mockResolvedValueOnce("900").mockResolvedValueOnce("901")
    m.rowStatus.value = null
    await markInvoiceStatusOnContact({ invoice: invoice({ status: "open" }) })
    expect(m.setValue).toHaveBeenCalledTimes(1)
  })
})
