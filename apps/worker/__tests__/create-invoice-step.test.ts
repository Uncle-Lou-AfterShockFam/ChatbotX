import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, test, vi } from "vitest"

const m = vi.hoisted(() => ({
  create: vi.fn(),
  markCreated: vi.fn(),
  getAll: vi.fn(),
  replaceAll: vi.fn(),
  logWarn: vi.fn(),
}))

vi.mock("@chatbotx.io/business/invoice", () => {
  class InvoiceFinalizeError extends Error {
    readonly retryable: boolean
    constructor(message: string, retryable: boolean) {
      super(message)
      this.retryable = retryable
    }
  }
  return {
    InvoiceFinalizeError,
    invoiceService: { create: (...a: unknown[]) => m.create(...a) },
    markInvoiceCreated: (...a: unknown[]) => m.markCreated(...a),
  }
})
vi.mock("@chatbotx.io/variables", () => ({
  contactVariableService: {
    getAll: (...a: unknown[]) => m.getAll(...a),
    replaceAll: (...a: unknown[]) => m.replaceAll(...a),
  },
}))
vi.mock("../src/lib/logger", () => ({
  logger: { warn: m.logWarn, error: vi.fn(), info: vi.fn() },
}))

const { handleCreateInvoice, invoiceSourceKey } = await import(
  "../src/integration/handlers/create-invoice"
)

const conversation = { workspaceId: "11", contactId: "22" }
const step = {
  id: "s1",
  stepType: "createInvoice",
  lines: [
    {
      description: "Order for {{first_name}}",
      quantity: 2,
      unitAmount: "{{price}}",
    },
  ],
  currency: "USD",
  dueInDays: 7,
  memo: "",
  states: [],
}
const props = (overrides: Record<string, unknown> = {}) =>
  ({
    conversation,
    contactInbox: { id: "ci-1" },
    step,
    flowExecutionKey: "run-1",
    ...overrides,
  }) as never

const invoice = {
  id: "900",
  number: 3,
  status: "open",
  total: "25.00",
  currency: "USD",
  hostedUrl: "https://invoice.stripe.com/i/x",
}

beforeEach(() => {
  vi.clearAllMocks()
  m.getAll.mockResolvedValue({})
  m.replaceAll.mockImplementation(({ text }: { text: string }) =>
    Promise.resolve(
      text.replace("{{first_name}}", "Lou").replace("{{price}}", "12.50"),
    ),
  )
  m.create.mockResolvedValue(invoice)
  m.markCreated.mockResolvedValue(undefined)
})

describe("worker registration", () => {
  test("createInvoice is wired in step.ts", () => {
    const source = readFileSync("src/integration/handlers/step.ts", "utf8")
    expect(source).toContain(
      "[stepTypes.enum.createInvoice]: handleCreateInvoice",
    )
  })
})

describe("createInvoice step", () => {
  test("renders variables, creates with a run-derived source key, writes the link fields", async () => {
    const result = await handleCreateInvoice(props())
    expect(result.status).toBe("success")
    expect(m.create).toHaveBeenCalledWith({
      workspaceId: "11",
      contactId: "22",
      currency: "USD",
      lines: [
        { description: "Order for Lou", quantity: 2, unitAmount: "12.50" },
      ],
      dueDays: 7,
      sourceKey: invoiceSourceKey("run-1", "s1"),
    })
    expect(m.markCreated).toHaveBeenCalledWith({
      invoice,
      contactInboxId: "ci-1",
    })
  })

  test("the source key is stable per (run, step) and differs across runs and steps", () => {
    expect(invoiceSourceKey("run-1", "s1")).toBe(
      invoiceSourceKey("run-1", "s1"),
    )
    expect(invoiceSourceKey("run-1", "s1")).not.toBe(
      invoiceSourceKey("run-2", "s1"),
    )
    expect(invoiceSourceKey("run-1", "s1")).not.toBe(
      invoiceSourceKey("run-1", "s2"),
    )
  })

  test("no execution key: error branch, nothing billed", async () => {
    const result = await handleCreateInvoice(
      props({ flowExecutionKey: undefined }),
    )
    expect(result.status).toBe("error")
    expect(m.create).not.toHaveBeenCalled()
  })

  test("no lines: error branch, nothing billed", async () => {
    const result = await handleCreateInvoice(
      props({ step: { ...step, lines: [] } }),
    )
    expect(result.status).toBe("error")
    expect(m.create).not.toHaveBeenCalled()
  })

  test("an empty rendered description falls back to Item N", async () => {
    m.replaceAll.mockImplementation(({ text }: { text: string }) =>
      Promise.resolve(text.startsWith("Order") ? "  " : "5"),
    )
    await handleCreateInvoice(props())
    expect(m.create.mock.calls[0]?.[0].lines[0].description).toBe("Item 1")
  })

  test("a service failure (Stripe not connected) takes the error branch and never throws", async () => {
    m.create.mockRejectedValue(new Error("Stripe is not connected"))
    const result = await handleCreateInvoice(props())
    expect(result).toEqual({
      status: "error",
      errorMessage: "Stripe is not connected",
      result: null,
    })
    expect(m.markCreated).not.toHaveBeenCalled()
  })
})
