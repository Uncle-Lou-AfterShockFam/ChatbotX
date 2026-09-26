import { beforeEach, describe, expect, test, vi } from "vitest"

/**
 * invoiceService (s205b) with the database mocked at the query-builder seam
 * and the Stripe provider mocked (finalizeWithStripe / voidWithStripe). The
 * credentials lookup is the REAL integrationStripeService: "not connected"
 * is its own `credentialsByWorkspaceIdOrFail` over an empty row, and a
 * connected workspace spies `credentialsByWorkspaceId` (no decrypt here).
 * What is pinned: every input rejection happens BEFORE any write or provider
 * call, the sourceKey replay never creates a second row or provider call, a
 * provider failure leaves a draft with lastError, and void refuses a paid
 * invoice without touching Stripe.
 */

const WS = "11"
const CONTACT = "21"
const INTEGRATION = "77"

const m = vi.hoisted(() => {
  const state = {
    /** The row `get` returns (db.query.invoiceModel.findFirst). */
    stored: null as Record<string, unknown> | null,
    /** tx.query.invoiceModel.findFirst: the sourceKey lookup. */
    bySourceKey: null as Record<string, unknown> | null,
    /** Results of each select(...).limit(1) in order: contact, then deal. */
    limitResults: [] as unknown[][],
    nextNumber: 1,
    stripeRow: null as Record<string, unknown> | null,
    transactions: 0,
    executes: 0,
    inserts: [] as Record<string, unknown>[],
    lineInserts: [] as Record<string, unknown>[][],
    updates: [] as Record<string, unknown>[],
    /** false = the CAS update matches no row. */
    updateMatches: true,
  }
  const selectChain: Record<string, unknown> = {}
  selectChain.from = () => selectChain
  selectChain.where = () => selectChain
  selectChain.limit = () => Promise.resolve(state.limitResults.shift() ?? [])
  // the max(number) aggregate is awaited without .limit()
  // biome-ignore lint/suspicious/noThenProperty: awaited query-builder stub
  selectChain.then = (resolve: (v: unknown) => unknown) =>
    resolve([{ next: state.nextNumber }])

  const insertChain = {
    values: (v: Record<string, unknown> | Record<string, unknown>[]) => {
      if (Array.isArray(v)) {
        state.lineInserts.push(v)
        return Promise.resolve(undefined)
      }
      state.inserts.push(v)
      return {
        returning: () => {
          const row = { id: "1001", ...v }
          state.stored = { ...row, lineItems: [] }
          return Promise.resolve([row])
        },
      }
    },
  }

  const makeUpdate = () => {
    let pending: Record<string, unknown> = {}
    const chain: Record<string, unknown> = {
      set: (v: Record<string, unknown>) => {
        pending = v
        state.updates.push(v)
        return chain
      },
      where: () => chain,
      returning: () => {
        if (!(state.updateMatches && state.stored)) {
          return Promise.resolve([])
        }
        state.stored = { ...state.stored, ...pending }
        return Promise.resolve([{ ...state.stored }])
      },
    }
    // the lastError write is awaited without .returning()
    // biome-ignore lint/suspicious/noThenProperty: awaited query-builder stub
    chain.then = (resolve: (v: unknown) => unknown) => {
      if (state.updateMatches && state.stored) {
        state.stored = { ...state.stored, ...pending }
      }
      return resolve(undefined)
    }
    return chain
  }

  const tx = {
    execute: () => {
      state.executes++
      return Promise.resolve(undefined)
    },
    select: () => selectChain,
    insert: () => insertChain,
    update: makeUpdate,
    query: {
      invoiceModel: {
        findFirst: () => Promise.resolve(state.bySourceKey ?? undefined),
      },
    },
  }
  const db = {
    ...tx,
    transaction: async (cb: (t: unknown) => unknown) => {
      state.transactions++
      return await cb(tx)
    },
    query: {
      invoiceModel: {
        findFirst: () =>
          Promise.resolve(state.stored ? { ...state.stored } : undefined),
      },
      integrationStripeModel: {
        findFirst: () => Promise.resolve(state.stripeRow ?? undefined),
      },
    },
  }
  return {
    state,
    db,
    finalize: vi.fn(),
    voidStripe: vi.fn(),
    emitCreated: vi.fn(),
    audit: vi.fn(),
    loggerWarn: vi.fn(),
  }
})

vi.mock("@chatbotx.io/database/client", () => ({
  db: m.db,
  and: (...c: unknown[]) => ({ and: c }),
  or: (...c: unknown[]) => ({ or: c }),
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
vi.mock("../src/invoice/stripe-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/invoice/stripe-provider")>()),
  finalizeWithStripe: (...a: unknown[]) => m.finalize(...a),
  voidWithStripe: (...a: unknown[]) => m.voidStripe(...a),
}))
vi.mock("@chatbotx.io/events", () => ({
  emitInvoiceCreated: (...a: unknown[]) => m.emitCreated(...a),
  emitInvoicePaid: vi.fn(),
  emitInvoicePaymentFailed: vi.fn(),
}))
vi.mock("../src/audit/dispatcher", () => ({
  dispatchAuditRecord: (...a: unknown[]) => m.audit(...a),
}))
vi.mock("../src/logger", () => ({
  logger: { warn: m.loggerWarn, error: vi.fn(), info: vi.fn() },
}))

const { invoiceService, InvoiceFinalizeError, invoiceRequestHash } =
  await import("../src/invoice/service")
const { integrationStripeService } = await import(
  "../src/integration-stripe/service"
)
const { InvoiceProviderError, STRIPE_MAX_AMOUNT_MINOR } = await import(
  "../src/invoice/stripe-provider"
)

const CREDENTIALS = {
  integrationId: INTEGRATION,
  workspaceId: WS,
  accountId: "acct_test_1",
  livemode: false,
  auth: {
    secretKey: ["sk", "test", "unitTestKey0123456789"].join("_"),
    webhookSecret: "whsec_unitTestSecret0123456789abcdef",
  },
}

const FINALIZED = {
  providerInvoiceId: "in_test_1",
  providerCustomerId: "cus_test_1",
  hostedUrl: "https://invoice.stripe.com/i/x",
  pdfUrl: "https://pay.stripe.com/invoice/x/pdf",
  dueAt: new Date("2026-10-10T00:00:00Z"),
  status: "open" as const,
}

const validInput = (overrides: Record<string, unknown> = {}) => ({
  workspaceId: WS,
  contactId: CONTACT,
  currency: "usd",
  dueDays: 14,
  lines: [
    { description: "Consult", quantity: 2, unitAmount: "12.50" },
    { description: "Report", quantity: 1, unitAmount: 100 },
  ],
  ...overrides,
})

/** The hash create() stores for validInput(): what a replay must match. */
const VALID_INPUT_HASH = () =>
  invoiceRequestHash({
    contactId: CONTACT,
    currency: "USD",
    dueDays: 14,
    lines: [
      { description: "Consult", quantity: 2, unitAmount: "12.50" },
      { description: "Report", quantity: 1, unitAmount: "100.00" },
    ],
  })

const line = (unitAmount: unknown, quantity = 1) => ({
  description: "Item",
  quantity,
  unitAmount,
})

const storedInvoice = (
  status: string,
  extra: Record<string, unknown> = {},
) => ({
  id: "9",
  workspaceId: WS,
  contactId: CONTACT,
  number: 9,
  status,
  method: "stripeInvoice",
  currency: "USD",
  total: "10.00",
  hostedUrl: null,
  dealId: null,
  integrationId: INTEGRATION,
  providerInvoiceId: null,
  dueAt: null,
  lineItems: [],
  ...extra,
})

let credentialsSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(m.state, {
    stored: null,
    bySourceKey: null,
    limitResults: [[{ id: CONTACT, companyId: "31" }]],
    nextNumber: 1,
    stripeRow: null,
    transactions: 0,
    executes: 0,
    inserts: [],
    lineInserts: [],
    updates: [],
    updateMatches: true,
  })
  credentialsSpy?.mockRestore()
  credentialsSpy = vi
    .spyOn(integrationStripeService, "credentialsByWorkspaceId")
    .mockResolvedValue(CREDENTIALS)
  m.finalize.mockResolvedValue(FINALIZED)
  m.voidStripe.mockResolvedValue(undefined)
  m.emitCreated.mockResolvedValue(undefined)
})

const expectNothingWritten = () => {
  expect(m.state.transactions).toBe(0)
  expect(m.state.inserts).toEqual([])
  expect(m.finalize).not.toHaveBeenCalled()
}

describe("invoiceService.create: input rejection (before any write)", () => {
  const fiftyOne = Array.from({ length: 51 }, () => line("1.00"))

  test.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "invoice"],
    ["a number", 42],
    ["an array", []],
    ["an unknown key", validInput({ amount: "5.00" })],
    [
      "an unknown line key",
      validInput({ lines: [{ ...line("1.00"), tax: 1 }] }),
    ],
    ["empty lines", validInput({ lines: [] })],
    ["51 lines", validInput({ lines: fiftyOne })],
    ["quantity 0", validInput({ lines: [line("1.00", 0)] })],
    ["quantity 1.5", validInput({ lines: [line("1.00", 1.5)] })],
    ["quantity 10001", validInput({ lines: [line("1.00", 10_001)] })],
    [
      "an empty description",
      validInput({ lines: [{ ...line("1"), description: " " }] }),
    ],
    ["a non-id workspace", validInput({ workspaceId: "ws-1" })],
    ["a non-id contact", validInput({ contactId: "1 OR 1=1" })],
    ["dueDays -1", validInput({ dueDays: -1 })],
    ["dueDays 366", validInput({ dueDays: 366 })],
    ["currency US", validInput({ currency: "US" })],
    ["currency USDX", validInput({ currency: "USDX" })],
    ["a NaN unit amount", validInput({ lines: [line(Number.NaN)] })],
    ["a boolean unit amount", validInput({ lines: [line(true)] })],
  ])("%s is rejected by the schema", async (_label, input) => {
    await expect(invoiceService.create(input as never)).rejects.toThrow()
    expectNothingWritten()
  })

  test.each<[string | number, string]>([
    ["abc", "letters"],
    ["-5", "negative string"],
    [-5, "negative number"],
    ["0", "zero"],
    [0, "zero number"],
    ["1.234", "three decimals"],
    [1e21, "1e21"],
  ])("unit amount %j (%s) is a validation error", async (amount) => {
    const error = await invoiceService
      .create(validInput({ lines: [line(amount)] }))
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ code: "validation", field: "lines" })
    expectNothingWritten()
  })

  test.each([
    ["KWD"],
    ["kwd"],
    ["BHD"],
    ["X1Z"],
  ])("currency %j is a validation error", async (currency) => {
    const error = await invoiceService
      .create(validInput({ currency }))
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ code: "validation", field: "currency" })
    expectNothingWritten()
  })

  test("JPY rejects a fractional unit amount", async () => {
    const error = await invoiceService
      .create(validInput({ currency: "JPY", lines: [line("100.50")] }))
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ code: "validation", field: "lines" })
  })

  test("a total over STRIPE_MAX_AMOUNT_MINOR is rejected; exactly the max is allowed", async () => {
    expect(STRIPE_MAX_AMOUNT_MINOR).toBe(99_999_999n)
    const over = await invoiceService
      .create(validInput({ lines: [line("999999.99", 2)] }))
      .catch((e: unknown) => e)
    expect(over).toMatchObject({ code: "validation", field: "invoice" })
    expectNothingWritten()

    const exact = await invoiceService.create(
      validInput({ lines: [line("999999.99", 1)] }),
    )
    expect(exact.total).toBe("999999.99")
  })

  test("Stripe not connected -> credentialMissing, no transaction", async () => {
    credentialsSpy.mockRestore()
    m.state.stripeRow = null
    const error = await invoiceService.create(validInput()).catch((e) => e)
    expect(error).toMatchObject({ code: "credentialMissing" })
    expectNothingWritten()
  })
})

describe("invoiceService.create: the write", () => {
  test("numbers from max+1, stores exact decimals, finalizes once, emits invoiceCreated", async () => {
    m.state.nextNumber = 7
    m.state.limitResults = [[{ id: CONTACT, companyId: "31" }], [{ id: "41" }]]
    const invoice = await invoiceService.create(
      validInput({ memo: "  Thanks  ", dealId: "41" }),
    )
    // contact lookup + deal lookup both ran
    expect(m.state.limitResults).toEqual([])
    expect(m.state.executes).toBe(1)
    expect(m.state.inserts).toHaveLength(1)
    expect(m.state.inserts[0]).toMatchObject({
      workspaceId: WS,
      number: 7,
      status: "draft",
      method: "stripeInvoice",
      currency: "USD",
      total: "125.00",
      memo: "Thanks",
      contactId: CONTACT,
      companyId: "31",
      integrationId: INTEGRATION,
      sourceKey: null,
    })
    expect(m.state.lineInserts[0]).toEqual([
      expect.objectContaining({
        position: 0,
        quantity: 2,
        unitAmount: "12.50",
        amount: "25.00",
      }),
      expect.objectContaining({
        position: 1,
        quantity: 1,
        unitAmount: "100.00",
        amount: "100.00",
      }),
    ])
    expect(m.finalize).toHaveBeenCalledTimes(1)
    expect(m.finalize.mock.calls[0]?.[0]).toMatchObject({
      credentials: CREDENTIALS,
      invoice: expect.objectContaining({ id: "1001" }),
    })
    expect(invoice).toMatchObject({
      status: "open",
      providerInvoiceId: "in_test_1",
      hostedUrl: FINALIZED.hostedUrl,
      lastError: null,
    })
    expect(m.emitCreated).toHaveBeenCalledTimes(1)
    expect(m.emitCreated).toHaveBeenCalledWith(
      WS,
      CONTACT,
      expect.objectContaining({ invoiceId: "1001", status: "open" }),
    )
  })

  test("a contact outside the workspace is not found, nothing inserted", async () => {
    m.state.limitResults = [[]]
    await expect(invoiceService.create(validInput())).rejects.toMatchObject({
      code: "notFound",
    })
    expect(m.state.inserts).toEqual([])
    expect(m.finalize).not.toHaveBeenCalled()
  })

  test("a deal outside the workspace is not found, nothing inserted", async () => {
    m.state.limitResults = [[{ id: CONTACT, companyId: null }], []]
    await expect(
      invoiceService.create(validInput({ dealId: "41" })),
    ).rejects.toMatchObject({ code: "notFound" })
    expect(m.state.inserts).toEqual([])
  })

  test("a sourceKey replay of an OPEN invoice returns it: no insert, no provider call", async () => {
    const existing = storedInvoice("open", {
      sourceKey: "flow-run-1",
      requestHash: VALID_INPUT_HASH(),
    })
    m.state.bySourceKey = existing
    m.state.stored = existing
    const invoice = await invoiceService.create(
      validInput({ sourceKey: "flow-run-1" }),
    )
    expect(invoice.id).toBe("9")
    expect(m.state.inserts).toEqual([])
    expect(m.state.lineInserts).toEqual([])
    expect(m.finalize).not.toHaveBeenCalled()
    expect(m.emitCreated).not.toHaveBeenCalled()
    expect(m.audit).not.toHaveBeenCalled()
  })

  test("a sourceKey replay of a DRAFT resumes its finalize (one provider call, no insert)", async () => {
    const existing = storedInvoice("draft", {
      sourceKey: "flow-run-2",
      requestHash: VALID_INPUT_HASH(),
    })
    m.state.bySourceKey = existing
    m.state.stored = existing
    const invoice = await invoiceService.create(
      validInput({ sourceKey: "flow-run-2" }),
    )
    expect(m.state.inserts).toEqual([])
    expect(m.finalize).toHaveBeenCalledTimes(1)
    expect(invoice.status).toBe("open")
  })

  test("a sourceKey replay with DIFFERENT content is refused (409) and bills nothing", async () => {
    const existing = storedInvoice("open", {
      sourceKey: "api-key-1",
      requestHash: VALID_INPUT_HASH(),
    })
    m.state.bySourceKey = existing
    m.state.stored = existing
    const error = await invoiceService
      .create(
        validInput({
          sourceKey: "api-key-1",
          lines: [{ description: "Consult", quantity: 2, unitAmount: "6.25" }],
        }),
      )
      .catch((e) => e)
    expect(error).toMatchObject({ code: "conflict", httpStatusCode: 409 })
    expect(m.state.inserts).toEqual([])
    expect(m.finalize).not.toHaveBeenCalled()
  })

  test("a replay for ANOTHER contact under the same key is refused, never returns that invoice", async () => {
    const existing = storedInvoice("open", {
      sourceKey: "api-key-2",
      requestHash: VALID_INPUT_HASH(),
    })
    m.state.bySourceKey = existing
    const error = await invoiceService
      .create(validInput({ sourceKey: "api-key-2", contactId: "99" }))
      .catch((e) => e)
    expect(error).toMatchObject({ code: "conflict" })
  })

  test("a non-retryable provider failure leaves the draft with lastError and throws InvoiceFinalizeError", async () => {
    m.finalize.mockRejectedValue(
      new InvoiceProviderError("Stripe add line item: bad currency", false),
    )
    const error = await invoiceService.create(validInput()).catch((e) => e)
    expect(error).toBeInstanceOf(InvoiceFinalizeError)
    expect(error).toMatchObject({
      code: "invoiceFinalizeFailed",
      retryable: false,
      message: "Stripe add line item: bad currency",
    })
    expect(error.invoice).toMatchObject({ id: "1001", status: "draft" })
    expect(m.state.updates).toEqual([
      expect.objectContaining({
        lastError: "Stripe add line item: bad currency",
      }),
    ])
    expect(m.state.stored).toMatchObject({
      status: "draft",
      lastError: "Stripe add line item: bad currency",
    })
    expect(m.emitCreated).not.toHaveBeenCalled()
  })

  test("an unexpected (non-provider) failure is retryable", async () => {
    m.finalize.mockRejectedValue(new Error("socket hang up"))
    const error = await invoiceService.create(validInput()).catch((e) => e)
    expect(error).toBeInstanceOf(InvoiceFinalizeError)
    expect(error.retryable).toBe(true)
    expect(m.state.stored).toMatchObject({ status: "draft" })
  })

  test("a retryable provider failure keeps retryable: true", async () => {
    m.finalize.mockRejectedValue(
      new InvoiceProviderError("Stripe create invoice: rate limited", true),
    )
    const error = await invoiceService.create(validInput()).catch((e) => e)
    expect(error.retryable).toBe(true)
  })

  test("finalize returning paid stores paid + paidAt", async () => {
    m.finalize.mockResolvedValue({ ...FINALIZED, status: "paid" })
    const invoice = await invoiceService.create(validInput())
    expect(invoice.status).toBe("paid")
    expect(invoice.paidAt).toBeInstanceOf(Date)
  })

  test("the invoiceCreated emit failing is logged, the invoice still returns", async () => {
    m.emitCreated.mockRejectedValue(new Error("bus down"))
    const invoice = await invoiceService.create(validInput())
    expect(invoice.status).toBe("open")
    expect(m.loggerWarn).toHaveBeenCalled()
  })
})

describe("invoiceService.finalize / void / transition", () => {
  test("finalize refuses a draft that belongs to a replaced Stripe connection", async () => {
    m.state.stored = storedInvoice("draft", { integrationId: "999" })
    await expect(
      invoiceService.finalize({ workspaceId: WS, id: "9" }),
    ).rejects.toMatchObject({ code: "validation" })
    expect(m.finalize).not.toHaveBeenCalled()
  })

  test("finalize on a non-draft returns it untouched", async () => {
    m.state.stored = storedInvoice("open")
    const invoice = await invoiceService.finalize({ workspaceId: WS, id: "9" })
    expect(invoice.status).toBe("open")
    expect(m.finalize).not.toHaveBeenCalled()
  })

  test.each([
    ["paid"],
    ["void"],
    ["refunded"],
  ])("void() on a %s invoice rejects without calling Stripe", async (status) => {
    m.state.stored = storedInvoice(status, { providerInvoiceId: "in_1" })
    await expect(
      invoiceService.void({ workspaceId: WS, id: "9" }),
    ).rejects.toMatchObject({ code: "validation", field: "invoice" })
    expect(m.voidStripe).not.toHaveBeenCalled()
    expect(m.state.updates).toEqual([])
  })

  test("void() on an open invoice voids at Stripe, then CAS to void", async () => {
    m.state.stored = storedInvoice("open", { providerInvoiceId: "in_1" })
    const invoice = await invoiceService.void({ workspaceId: WS, id: "9" })
    expect(m.voidStripe).toHaveBeenCalledTimes(1)
    expect(invoice.status).toBe("void")
    expect(invoice.voidedAt).toBeInstanceOf(Date)
  })

  test("void() on a draft never sent to Stripe skips the provider", async () => {
    m.state.stored = storedInvoice("draft")
    const invoice = await invoiceService.void({ workspaceId: WS, id: "9" })
    expect(m.voidStripe).not.toHaveBeenCalled()
    expect(invoice.status).toBe("void")
  })

  test("a Stripe void failure is a validation error and the row stays open", async () => {
    m.state.stored = storedInvoice("open", { providerInvoiceId: "in_1" })
    m.voidStripe.mockRejectedValue(
      new InvoiceProviderError("A paid invoice cannot be voided", false),
    )
    await expect(
      invoiceService.void({ workspaceId: WS, id: "9" }),
    ).rejects.toMatchObject({ code: "validation" })
    expect(m.state.stored).toMatchObject({ status: "open" })
  })

  test("transition to draft is never allowed (no query issued)", async () => {
    expect(
      await invoiceService.transition({ invoiceId: "9", to: "draft" }),
    ).toBeNull()
    expect(m.state.updates).toEqual([])
  })

  test("a CAS that matches no row returns null", async () => {
    m.state.stored = storedInvoice("paid")
    m.state.updateMatches = false
    expect(
      await invoiceService.transition({ invoiceId: "9", to: "open" }),
    ).toBeNull()
  })

  test("get() for an assigned-only member hides an invoice outside their conversations", async () => {
    m.state.stored = storedInvoice("open")
    m.state.limitResults = [[]]
    await expect(
      invoiceService.get({
        workspaceId: WS,
        id: "9",
        restrictToAssignedUserId: "5",
      }),
    ).rejects.toMatchObject({ code: "notFound" })
    m.state.limitResults = [[{ id: "9" }]]
    const visible = await invoiceService.get({
      workspaceId: WS,
      id: "9",
      restrictToAssignedUserId: "5",
    })
    expect(visible.id).toBe("9")
  })

  test("get() of a missing invoice is not found", async () => {
    await expect(
      invoiceService.get({ workspaceId: WS, id: "404" }),
    ).rejects.toMatchObject({ code: "notFound" })
  })
})

describe("invoiceService.finalize: Stripe status mapping and the void race (s205b review)", () => {
  test("a Stripe invoice found VOID at resume is stored void, never open with a dead link", async () => {
    m.finalize.mockResolvedValue({ ...FINALIZED, status: "void" })
    const invoice = await invoiceService.create(validInput())
    expect(invoice.status).toBe("void")
    expect(m.state.updates.at(-1)).toMatchObject({ status: "void" })
    expect(m.emitCreated).not.toHaveBeenCalled()
  })

  test("a Stripe status the hub cannot map (still draft) is a retryable finalize error", async () => {
    m.finalize.mockResolvedValue({ ...FINALIZED, status: "draft" })
    const error = await invoiceService.create(validInput()).catch((e) => e)
    expect(error).toBeInstanceOf(InvoiceFinalizeError)
    expect(error.retryable).toBe(true)
  })

  test("voided here while Stripe opened it: the Stripe invoice is voided too", async () => {
    // The finalize CAS (draft -> open) misses because the row went void.
    m.finalize.mockImplementation(() => {
      m.state.updateMatches = false
      return Promise.resolve(FINALIZED)
    })
    // create: contact lookup; then the race re-read of the status. The row
    // itself carries NO Stripe id: the void must use the one Stripe returned.
    m.state.limitResults = [
      [{ id: CONTACT, companyId: "31" }],
      [{ status: "void" }],
    ]
    await invoiceService.create(validInput())
    expect(m.voidStripe).toHaveBeenCalledTimes(1)
    expect(m.voidStripe.mock.calls[0]?.[0].invoice).toMatchObject({
      providerInvoiceId: FINALIZED.providerInvoiceId,
    })
  })

  test("a lost CAS on a row that is NOT void leaves Stripe alone", async () => {
    m.finalize.mockImplementation(() => {
      m.state.updateMatches = false
      return Promise.resolve(FINALIZED)
    })
    m.state.limitResults = [
      [{ id: CONTACT, companyId: "31" }],
      [{ status: "paid" }],
    ]
    await invoiceService.create(validInput())
    expect(m.voidStripe).not.toHaveBeenCalled()
  })
})
