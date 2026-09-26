import { beforeEach, describe, expect, test, vi } from "vitest"

/**
 * The hub's invoice / receipt PDF (s210b). The page HTML is pure; the
 * store/serve path is pinned at the documentService + db seams (the render,
 * the object write and the race are documentService's, tested there and in
 * the real-PG suite).
 */
const m = vi.hoisted(() => ({
  selects: [] as unknown[][],
  findFirst: vi.fn(),
  findByRef: vi.fn(),
  assertGenerateBudget: vi.fn(),
  storeRenderedPdf: vi.fn(),
  getObject: vi.fn(),
  warn: vi.fn(),
}))

vi.mock("@chatbotx.io/database/client", async (importOriginal) => {
  const chain = () => {
    const self: Record<string, unknown> = {}
    for (const k of ["from", "where", "limit"]) {
      self[k] = () => self
    }
    // biome-ignore lint/suspicious/noThenProperty: awaitable like a drizzle query
    self.then = (ok: (v: unknown) => unknown) =>
      Promise.resolve(m.selects.shift() ?? []).then(ok)
    return self
  }
  return {
    ...(await importOriginal<object>()),
    db: {
      select: () => chain(),
      query: { invoiceModel: { findFirst: m.findFirst } },
    },
  }
})
vi.mock("../src/documents/service", () => ({
  documentService: {
    findByRef: m.findByRef,
    assertGenerateBudget: m.assertGenerateBudget,
    storeRenderedPdf: m.storeRenderedPdf,
  },
}))
vi.mock("@chatbotx.io/filesystem", () => ({
  uploader: { getObject: m.getObject },
}))
vi.mock("../src/logger", () => ({
  logger: { warn: m.warn, error: vi.fn(), info: vi.fn() },
}))

const {
  ensureInvoiceDocument,
  formatInvoiceMoney,
  invoiceDocumentRef,
  prerenderInvoiceReceipt,
  renderInvoiceHtml,
  visitInvoicePdf,
} = await import("../src/invoice/document")

const TOKEN = "0123456789ABCDEFGHIJKL"
const RAW_MARKUP = /<script>|<img |<iframe|<b>Shop/
const baseInvoice = {
  number: 7,
  currency: "USD",
  total: "1250.50",
  memo: null as string | null,
  dueAt: new Date("2026-10-03T00:00:00Z"),
  paidAt: null as Date | null,
  createdAt: new Date("2026-09-26T03:30:00Z"),
}
const line = (over: Record<string, unknown> = {}) => ({
  position: 0,
  description: "Consulting",
  quantity: 2,
  unitAmount: "625.25",
  amount: "1250.50",
  ...over,
})
const contact = {
  fullName: "Pat Doe",
  email: "pat@example.com",
  phoneNumber: "+15550001234",
}
const workspace = { name: "AfterShock", timezone: "America/New_York" }
const render = (over: Partial<Parameters<typeof renderInvoiceHtml>[0]> = {}) =>
  renderInvoiceHtml({
    kind: "invoice",
    invoice: baseInvoice,
    lines: [line()],
    contact,
    workspace,
    ...over,
  })

describe("renderInvoiceHtml", () => {
  test("an open invoice: title, bill-to, lines, total due and the UTC due day", () => {
    const html = render()
    expect(html).toContain("<title>Invoice #7</title>")
    expect(html).toContain("Bill to")
    expect(html).toContain("Pat Doe<br>pat@example.com<br>+15550001234")
    expect(html).toContain("$625.25")
    expect(html).toContain("Total due (USD)")
    expect(html).toContain("$1,250.50")
    expect(html).toContain("Due October 3, 2026")
    // Issued on the WORKSPACE's day: 03:30Z is Sept 25 in New York.
    expect(html).toContain("Issued September 25, 2026")
    expect(html).not.toContain("PAID")
  })

  test("a receipt: PAID badge and the paid time in the workspace zone", () => {
    const html = render({
      kind: "receipt",
      invoice: { ...baseInvoice, paidAt: new Date("2026-09-26T21:48:31Z") },
    })
    expect(html).toContain("<title>Receipt #7</title>")
    expect(html).toContain("PAID")
    expect(html).toContain("Received from")
    expect(html).toContain("Total paid (USD)")
    expect(html).toContain("Paid September 26, 2026 5:48 PM EDT")
    expect(html).not.toContain("Due ")
  })

  test("a bad workspace zone falls back to UTC instead of failing the render", () => {
    const html = render({ workspace: { name: "W", timezone: "Mars/Olympus" } })
    expect(html).toContain("Issued September 26, 2026")
  })

  test("every value is escaped: no markup from a contact, line or memo", () => {
    const html = render({
      contact: {
        fullName: "<script>alert(1)</script>",
        email: null,
        phoneNumber: null,
      },
      lines: [line({ description: '<img src=x onerror=alert(1)>"' })],
      invoice: { ...baseInvoice, memo: "</div><iframe src=//evil>" },
      workspace: { name: "<b>Shop</b>", timezone: "UTC" },
    })
    expect(html).not.toMatch(RAW_MARKUP)
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;&quot;")
  })

  test("a line reading like a Documenso field stays plain text (no signing pass)", () => {
    const html = render({ lines: [line({ description: "{{signature, r1}}" })] })
    expect(html).toContain("{{signature, r1}}")
    expect(html).not.toContain('doc-ph-sig">')
  })

  test("zero-decimal currencies print no fraction", () => {
    const html = render({
      invoice: { ...baseInvoice, currency: "JPY", total: "1250.00" },
      lines: [line({ unitAmount: "625.00", amount: "1250.00" })],
    })
    expect(html).toContain("¥1,250")
    expect(html).not.toContain("¥1,250.00")
  })

  test("no contact details, no memo, no due date: those blocks are left out", () => {
    const html = render({
      contact: { fullName: null, email: " ", phoneNumber: null },
      invoice: { ...baseInvoice, dueAt: null, memo: "  " },
    })
    expect(html).not.toContain("Bill to")
    expect(html).not.toContain('inv-memo">')
    expect(html).not.toContain("Due ")
  })

  test("lines print in position order; multi-line descriptions keep their breaks", () => {
    const html = render({
      lines: [
        line({ position: 1, description: "Second" }),
        line({ position: 0, description: "First\nline two" }),
      ],
    })
    expect(html.indexOf("First<br>line two")).toBeLessThan(
      html.indexOf("Second"),
    )
  })

  test("fifty lines render (the create cap)", () => {
    const lines = Array.from({ length: 50 }, (_, i) =>
      line({ position: i, description: `Item ${i}` }),
    )
    const html = render({ lines })
    expect(html.match(/<tr><td>Item /g)).toHaveLength(50)
  })
})

describe("formatInvoiceMoney", () => {
  test("formats the exact decimal string", () => {
    expect(formatInvoiceMoney("999999999999.99", "USD")).toBe(
      "$999,999,999,999.99",
    )
    expect(formatInvoiceMoney("0.10", "EUR")).toBe("€0.10")
  })
  test("an unknown code degrades to the raw value, never throws", () => {
    expect(formatInvoiceMoney("12.50", "not-a-code")).toBe("12.50 not-a-code")
  })
})

const stored = (over: Record<string, unknown> = {}) => ({
  id: "d1",
  title: "Invoice #7",
  path: "workspaces/11/documents/21/d1.pdf",
  ...over,
})
const invoiceRow = (over: Record<string, unknown> = {}) => ({
  ...baseInvoice,
  id: "501",
  workspaceId: "11",
  contactId: "21",
  method: "stripeCheckout",
  status: "open",
  lineItems: [line()],
  ...over,
})

beforeEach(() => {
  // reset, not clear: a test's mockRejectedValue must not leak into the next.
  vi.resetAllMocks()
  m.selects.length = 0
  m.findByRef.mockResolvedValue(undefined)
  m.storeRenderedPdf.mockResolvedValue({ document: stored(), created: true })
  m.getObject.mockResolvedValue(Buffer.from("%PDF-1.7 %%EOF"))
})

describe("ensureInvoiceDocument", () => {
  test("a stored document is returned without rendering", async () => {
    m.findByRef.mockResolvedValue(stored())
    const doc = await ensureInvoiceDocument({
      invoice: invoiceRow() as never,
      kind: "invoice",
    })
    expect(doc.id).toBe("d1")
    expect(m.findByRef).toHaveBeenCalledWith(
      expect.objectContaining({ contactId: "21", ref: "invoice:501:invoice" }),
    )
    expect(m.assertGenerateBudget).not.toHaveBeenCalled()
    expect(m.storeRenderedPdf).not.toHaveBeenCalled()
  })

  test("a miss passes the budget, then stores ONE ref'd document without a template", async () => {
    m.selects.push([contact], [workspace])
    await ensureInvoiceDocument({
      invoice: invoiceRow() as never,
      kind: "receipt",
    })
    expect(m.assertGenerateBudget).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "11", kind: "invoice" }),
    )
    const call = m.storeRenderedPdf.mock.calls[0]?.[0]
    expect(call).toMatchObject({
      workspaceId: "11",
      contactId: "21",
      templateId: null,
      title: "Receipt #7",
      ref: invoiceDocumentRef("501", "receipt"),
      field: "invoice",
    })
    expect(call.html).toContain("Pat Doe")
  })

  test("over budget: nothing is rendered and the refusal propagates", async () => {
    m.selects.push([contact], [workspace])
    m.assertGenerateBudget.mockRejectedValue(new Error("Too many documents"))
    await expect(
      ensureInvoiceDocument({
        invoice: invoiceRow() as never,
        kind: "invoice",
      }),
    ).rejects.toThrow("Too many documents")
    expect(m.storeRenderedPdf).not.toHaveBeenCalled()
  })

  test("a contact that is gone (or in another workspace) is an error, not a blank PDF", async () => {
    m.selects.push([], [workspace])
    await expect(
      ensureInvoiceDocument({
        invoice: invoiceRow() as never,
        kind: "invoice",
      }),
    ).rejects.toThrow("contact or workspace is gone")
    expect(m.storeRenderedPdf).not.toHaveBeenCalled()
  })
})

describe("visitInvoicePdf", () => {
  const canServe = async () => true

  test.each([
    ["a malformed token", "short", undefined],
    ["an unknown token", TOKEN, undefined],
    ["a stripeInvoice", TOKEN, invoiceRow({ method: "stripeInvoice" })],
    ["a draft", TOKEN, invoiceRow({ status: "draft" })],
    ["a void invoice", TOKEN, invoiceRow({ status: "void" })],
    ["a refunded invoice", TOKEN, invoiceRow({ status: "refunded" })],
    [
      "an uncollectible invoice",
      TOKEN,
      invoiceRow({ status: "uncollectible" }),
    ],
  ])("%s is notFound, nothing rendered", async (_label, token, row) => {
    m.findFirst.mockResolvedValue(row)
    expect(await visitInvoicePdf(token, { canServe })).toEqual({
      kind: "notFound",
    })
    expect(m.storeRenderedPdf).not.toHaveBeenCalled()
    expect(m.getObject).not.toHaveBeenCalled()
  })

  test("a malformed token never reaches the database", async () => {
    await visitInvoicePdf("x".repeat(500), { canServe })
    expect(m.findFirst).not.toHaveBeenCalled()
  })

  test("a frozen workspace is refused before anything renders", async () => {
    m.findFirst.mockResolvedValue(invoiceRow())
    const frozen = vi.fn(async () => false)
    expect(await visitInvoicePdf(TOKEN, { canServe: frozen })).toEqual({
      kind: "frozen",
    })
    expect(frozen).toHaveBeenCalledWith("11")
    expect(m.findByRef).not.toHaveBeenCalled()
  })

  test.each([
    ["open", "invoice:501:invoice"],
    ["paid", "invoice:501:receipt"],
  ])("%s serves its %s document from storage", async (status, ref) => {
    m.findFirst.mockResolvedValue(invoiceRow({ status }))
    m.findByRef.mockResolvedValue(stored({ title: "Doc" }))
    const visit = await visitInvoicePdf(TOKEN, { canServe })
    expect(m.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { payToken: TOKEN } }),
    )
    expect(m.findByRef).toHaveBeenCalledWith(expect.objectContaining({ ref }))
    expect(visit).toMatchObject({ kind: "pdf", title: "Doc" })
    expect(m.getObject).toHaveBeenCalledWith(
      "workspaces/11/documents/21/d1.pdf",
    )
  })

  test("a render or storage failure throws (the route answers 503)", async () => {
    m.findFirst.mockResolvedValue(invoiceRow())
    m.findByRef.mockResolvedValue(stored())
    m.getObject.mockRejectedValue(new Error("NoSuchKey"))
    await expect(visitInvoicePdf(TOKEN, { canServe })).rejects.toThrow(
      "NoSuchKey",
    )
  })

  test("a row with no file path throws rather than serving nothing", async () => {
    m.findFirst.mockResolvedValue(invoiceRow())
    m.findByRef.mockResolvedValue(stored({ path: null }))
    await expect(visitInvoicePdf(TOKEN, { canServe })).rejects.toThrow(
      "has no file",
    )
  })
})

describe("prerenderInvoiceReceipt", () => {
  test("a paid checkout invoice stores its receipt", async () => {
    m.findFirst.mockResolvedValue(invoiceRow({ status: "paid" }))
    m.selects.push([contact], [workspace])
    await prerenderInvoiceReceipt("501")
    expect(m.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "501" } }),
    )
    expect(m.storeRenderedPdf).toHaveBeenCalledWith(
      expect.objectContaining({ ref: "invoice:501:receipt" }),
    )
  })

  test.each([
    ["not paid (yet or any more)", invoiceRow({ status: "open" })],
    [
      "a stripeInvoice",
      invoiceRow({ status: "paid", method: "stripeInvoice" }),
    ],
    ["gone", undefined],
  ])("%s: nothing rendered", async (_label, row) => {
    m.findFirst.mockResolvedValue(row)
    await prerenderInvoiceReceipt("501")
    expect(m.storeRenderedPdf).not.toHaveBeenCalled()
  })

  test("never throws: a failure is a warning (the visit renders on demand)", async () => {
    m.findFirst.mockRejectedValue(new Error("db down"))
    await expect(prerenderInvoiceReceipt("501")).resolves.toBeUndefined()
    m.findFirst.mockResolvedValue(invoiceRow({ status: "paid" }))
    m.selects.push([contact], [workspace])
    m.storeRenderedPdf.mockRejectedValue(
      new Error("Could not render the PDF (timeout)"),
    )
    await expect(prerenderInvoiceReceipt("501")).resolves.toBeUndefined()
    expect(m.warn).toHaveBeenCalledTimes(2)
  })
})
