import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

/**
 * Invoices list (s210b): the PDF action links the row's `pdfUrl`, and below
 * `sm` the total and the dates fold into other cells so every action stays
 * on screen at 375 px (live: the table was 344 px in a 293 px wrapper).
 */
const m = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }))

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useFormatter: () => ({
    number: (value: number) => `$${value.toFixed(2)}`,
    dateTime: () => "Oct 3, 2026",
  }),
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock("@/features/invoices/provider/invoice-hooks", () => ({
  useInvoices: () => ({
    isLoading: false,
    hasNextPage: false,
    data: { pages: [{ data: m.rows }] },
  }),
  useVoidInvoice: () => ({ mutate: vi.fn(), isPending: false }),
  useFinalizeInvoice: () => ({ mutate: vi.fn(), isPending: false }),
}))

const { InvoiceList } = await import(
  "@/features/invoices/components/invoice-list"
)

const row = (over: Record<string, unknown> = {}) => ({
  id: "5",
  number: 5,
  status: "paid",
  method: "stripeCheckout",
  currency: "USD",
  total: "1.00",
  memo: null,
  contactId: "21",
  companyId: null,
  dealId: null,
  hostedUrl: "https://chat.example.org/pay/tok",
  pdfUrl: "https://chat.example.org/pay/tok/pdf",
  dueAt: new Date("2026-10-03T00:00:00Z"),
  paidAt: null,
  voidedAt: null,
  lastError: null,
  createdAt: new Date("2026-09-26T00:00:00Z"),
  updatedAt: new Date("2026-09-26T00:00:00Z"),
  ...over,
})

describe("InvoiceList", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const render = (rows: Record<string, unknown>[]) => {
    m.rows = rows
    act(() => root.render(<InvoiceList workspaceId="ws-1" />))
  }

  test("a row with a pdfUrl gets an Open PDF link to it; one without gets none", () => {
    render([row(), row({ id: "6", number: 6, status: "void", pdfUrl: null })])
    const pdf = container.querySelector<HTMLAnchorElement>(
      '[data-testid="invoice-pdf-5"]',
    )
    expect(pdf?.getAttribute("href")).toBe(
      "https://chat.example.org/pay/tok/pdf",
    )
    expect(pdf?.getAttribute("target")).toBe("_blank")
    expect(pdf?.getAttribute("aria-label")).toBe("invoices.openPdf")
    expect(container.querySelector('[data-testid="invoice-pdf-6"]')).toBeNull()
  })

  test("below sm, Total / Created / Due columns are hidden and folded into the row", () => {
    render([row()])
    const heads = Array.from(container.querySelectorAll("th"))
    const hiddenOnMobile = heads
      .filter((th) => th.className.includes("hidden"))
      .map((th) => th.textContent)
    expect(hiddenOnMobile).toEqual([
      "invoices.fields.total",
      "invoices.fields.created",
      "invoices.fields.due",
    ])
    const cells = Array.from(
      container.querySelectorAll('[data-testid="invoice-row-5"] td'),
    )
    // Every hidden header has a hidden cell: the columns stay aligned.
    expect(cells.filter((td) => td.className.includes("hidden"))).toHaveLength(
      3,
    )
    const folded = Array.from(
      container.querySelectorAll("p.sm\\:hidden"),
      (p) => p.textContent,
    )
    expect(folded).toEqual(["invoices.fields.due Oct 3, 2026", "$1.00"])
  })
})
