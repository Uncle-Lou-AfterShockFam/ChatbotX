import { describe, expect, test } from "vitest"
import {
  invoiceDocumentKind,
  invoicePdfUrl,
  invoiceStatuses,
} from "../src/partials/invoice"

/** s210b: which invoices have a hub PDF, and the link the API/UI shows. */
describe("invoiceDocumentKind", () => {
  const expected: Record<string, string | null> = {
    open: "invoice",
    paid: "receipt",
  }
  test.each(invoiceStatuses.options)("%s", (status) => {
    expect(invoiceDocumentKind(status)).toBe(expected[status] ?? null)
  })
})

describe("invoicePdfUrl", () => {
  const pay = "https://chat.example.org/pay/0123456789ABCDEFGHIJKL"
  test("stripeInvoice keeps Stripe's PDF (or none)", () => {
    expect(
      invoicePdfUrl({
        method: "stripeInvoice",
        status: "paid",
        hostedUrl: "https://invoice.stripe.com/i/x",
        pdfUrl: "https://pay.stripe.com/invoice/x/pdf",
      }),
    ).toBe("https://pay.stripe.com/invoice/x/pdf")
    expect(
      invoicePdfUrl({
        method: "stripeInvoice",
        status: "draft",
        hostedUrl: null,
        pdfUrl: null,
      }),
    ).toBeNull()
  })
  test.each([
    "open",
    "paid",
  ] as const)("an %s checkout invoice links /pay/<token>/pdf", (status) => {
    expect(
      invoicePdfUrl({
        method: "stripeCheckout",
        status,
        hostedUrl: pay,
        pdfUrl: null,
      }),
    ).toBe(`${pay}/pdf`)
  })
  test.each([
    "draft",
    "void",
    "uncollectible",
    "refunded",
  ] as const)("a %s checkout invoice has no PDF link", (status) => {
    expect(
      invoicePdfUrl({
        method: "stripeCheckout",
        status,
        hostedUrl: pay,
        pdfUrl: null,
      }),
    ).toBeNull()
  })
  test("a checkout invoice without a pay link has no PDF link", () => {
    expect(
      invoicePdfUrl({
        method: "stripeCheckout",
        status: "open",
        hostedUrl: null,
        pdfUrl: null,
      }),
    ).toBeNull()
  })
})
