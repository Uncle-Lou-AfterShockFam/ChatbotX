import { beforeEach, describe, expect, test, vi } from "vitest"

/**
 * Invoice marks on the contact (s212b, s237). An in-memory contact (field ->
 * value) and invoice table (id -> status) stand in for Postgres; the
 * interleavings a blind probe found on real Postgres (s237 T1-T4) are replayed
 * by holding one write while another mark runs to completion.
 */

const m = vi.hoisted(() => ({
  /** custom field id -> value, for the one contact under test. */
  fields: new Map<string, string>(),
  /** invoice id -> row status (absent = no row). */
  rows: new Map<string, string>(),
  /** The next write of this field name waits on `hold` before it lands. */
  holdField: null as string | null,
  hold: null as Promise<void> | null,
  writes: [] as { name: string; value: string; contactInboxId?: string }[],
  resolveCalls: [] as { fields: { name: string; type: string }[] }[],
  attach: vi.fn(),
}))

const idOf = (name: string) => `cf:${name}`
const nameOf = (id: string) => id.slice(3)

vi.mock("@chatbotx.io/database/client", () => {
  /** The row a select reads: the value of its `eq(<id column>, value)`. */
  let wantedId: string | undefined
  const chain: Record<string, unknown> = {}
  chain.from = () => chain
  chain.where = () => chain
  chain.limit = () => {
    const status = wantedId ? m.rows.get(wantedId) : undefined
    return Promise.resolve(status ? [{ status }] : [])
  }
  return {
    db: { select: () => chain },
    eq: (column: { name?: string }, value: string) => {
      if (column?.name === "id") {
        wantedId = value
      }
      return {}
    },
    and: () => ({}),
  }
})

vi.mock("../src/custom-field/service", () => ({
  customFieldService: {
    resolveByNameAndType: async (arg: {
      fields: { name: string; type: string }[]
    }) => {
      m.resolveCalls.push(arg)
      return {
        idMap: new Map(
          arg.fields.map((f) => [`${f.type}:${f.name}`, idOf(f.name)]),
        ),
        createdIds: [],
      }
    },
  },
}))
vi.mock("../src/contact-custom-field/service", () => ({
  contactCustomFieldService: {
    setValueByKey: async (arg: {
      keyword: string
      value: string
      contactInboxId?: string
    }) => {
      const name = nameOf(arg.keyword)
      if (m.hold && m.holdField === name) {
        const gate = m.hold
        m.hold = null
        await gate
      }
      m.fields.set(arg.keyword, arg.value)
      m.writes.push({
        name,
        value: arg.value,
        contactInboxId: arg.contactInboxId,
      })
    },
    findValue: async (arg: { customFieldId: string }) =>
      m.fields.get(arg.customFieldId) ?? null,
  },
}))
vi.mock("../src/tag/service", () => ({
  tagService: { attachByNamesToContacts: (...a: unknown[]) => m.attach(...a) },
}))
vi.mock("../src/logger", () => ({ logger: { warn: vi.fn() } }))

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

const field = (name: string) => m.fields.get(idOf(name))

/** Holds the next write of `name` until the returned release() runs. */
function holdNextWrite(name: string): () => void {
  let release = () => {}
  m.holdField = name
  m.hold = new Promise<void>((resolve) => {
    release = resolve
  })
  return release
}

/** Lets a held mark run up to its held write. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  vi.clearAllMocks()
  m.fields.clear()
  m.rows.clear()
  m.rows.set("900", "open")
  m.hold = null
  m.holdField = null
  m.writes = []
  m.resolveCalls = []
})

describe("markInvoiceCreated", () => {
  test("stripeInvoice: pay link, Stripe's PDF, id, status; the inbox rides every write", async () => {
    await markInvoiceCreated({ invoice: invoice(), contactInboxId: "ci-1" })
    expect(field("invoice_link")).toBe("https://invoice.stripe.com/i/x")
    expect(field("invoice_pdf_link")).toBe(
      "https://pay.stripe.com/invoice/x/pdf",
    )
    expect(field("invoice_last_id")).toBe("900")
    expect(field("invoice_last_status")).toBe("open")
    expect(m.writes.length).toBeGreaterThan(0)
    for (const write of m.writes) {
      expect(write.contactInboxId).toBe("ci-1")
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
    expect(field("invoice_link")).toBe("https://hub.example/pay/tok")
    expect(field("invoice_pdf_link")).toBe("https://hub.example/pay/tok/pdf")
  })

  test('a woocommerce invoice with no stored PDF (opened before s213b) and a missing link write "", never "null"', async () => {
    await markInvoiceCreated({
      invoice: invoice({
        method: "woocommerce",
        hostedUrl: null,
        pdfUrl: null,
      }),
    })
    expect(field("invoice_link")).toBe("")
    expect(field("invoice_pdf_link")).toBe("")
    expect(m.writes[0]?.contactInboxId).toBeUndefined()
  })

  test("the status comes from the ROW: a webhook that already paid it wins (s212b review)", async () => {
    m.rows.set("900", "paid")
    await markInvoiceCreated({ invoice: invoice() })
    expect(field("invoice_last_status")).toBe("paid")
  })

  test("an unchanged status is not written again", async () => {
    await markInvoiceCreated({ invoice: invoice() })
    await markInvoiceCreated({ invoice: invoice() })
    expect(
      m.writes.filter((w) => w.name === "invoice_last_status"),
    ).toHaveLength(1)
  })

  test("a missing row writes no status", async () => {
    m.rows.clear()
    await markInvoiceCreated({ invoice: invoice() })
    expect(field("invoice_last_status")).toBeUndefined()
  })

  test("every field is created as shortText", async () => {
    await markInvoiceCreated({ invoice: invoice() })
    const types = m.resolveCalls.flatMap((c) => c.fields.map((f) => f.type))
    expect(types.length).toBeGreaterThan(0)
    expect(new Set(types)).toEqual(new Set(["shortText"]))
  })
})

describe("webhook marks follow the contact's LATEST invoice (s237)", () => {
  test("the latest invoice paid: status, paid id and tag", async () => {
    await markInvoiceCreated({ invoice: invoice() })
    m.rows.set("900", "paid")
    await markInvoiceOnContact({ invoice: invoice(), status: "paid" })
    expect(field("invoice_last_status")).toBe("paid")
    expect(field("invoice_paid_id")).toBe("900")
    expect(m.attach).toHaveBeenCalledTimes(1)
  })

  test("an OLDER invoice paid while a newer one is open: paid id + tag, never the status (live #26/#28)", async () => {
    await markInvoiceCreated({ invoice: invoice() })
    m.rows.set("901", "open")
    await markInvoiceCreated({ invoice: invoice({ id: "901" }) })
    m.rows.set("900", "paid")
    await markInvoiceOnContact({ invoice: invoice(), status: "paid" })
    expect(field("invoice_last_status")).toBe("open")
    expect(field("invoice_paid_id")).toBe("900")
    expect(m.attach).toHaveBeenCalledTimes(1)
  })

  test("an older invoice's deposit writes the deposit id only", async () => {
    m.rows.set("901", "open")
    await markInvoiceCreated({ invoice: invoice({ id: "901" }) })
    m.rows.set("900", "partiallyPaid")
    await markInvoiceOnContact({ invoice: invoice(), status: "partiallyPaid" })
    expect(field("invoice_deposit_paid_id")).toBe("900")
    expect(field("invoice_last_status")).toBe("open")
  })

  test("payment_failed lands on the latest open invoice and stands while it stays open", async () => {
    await markInvoiceCreated({ invoice: invoice() })
    await markInvoiceOnContact({ invoice: invoice(), status: "payment_failed" })
    expect(field("invoice_last_status")).toBe("payment_failed")
    await markInvoiceStatusOnContact({ invoice: invoice() })
    expect(field("invoice_last_status")).toBe("payment_failed")
  })

  test("an older invoice's failed payment writes nothing", async () => {
    m.rows.set("901", "open")
    await markInvoiceCreated({ invoice: invoice({ id: "901" }) })
    const before = m.writes.length
    await markInvoiceOnContact({ invoice: invoice(), status: "payment_failed" })
    expect(m.writes).toHaveLength(before)
    expect(m.attach).not.toHaveBeenCalled()
  })

  test("a refund rollback of the latest moves its status; of an older one, nothing", async () => {
    m.rows.set("900", "paid")
    await markInvoiceCreated({ invoice: invoice() })
    m.rows.set("900", "partiallyPaid")
    await markInvoiceStatusOnContact({ invoice: invoice() })
    expect(field("invoice_last_status")).toBe("partiallyPaid")
    m.rows.set("901", "open")
    await markInvoiceCreated({ invoice: invoice({ id: "901" }) })
    m.rows.set("900", "open")
    await markInvoiceStatusOnContact({ invoice: invoice() })
    expect(field("invoice_last_status")).toBe("open")
    expect(field("invoice_last_id")).toBe("901")
  })
})

describe("a late write never leaves a stale status (s237 probe T1-T4)", () => {
  test("T1: an older invoice's pay write lands after a newer create and its payment", async () => {
    await markInvoiceCreated({ invoice: invoice() })
    m.rows.set("900", "paid")
    const release = holdNextWrite("invoice_last_status")
    const payA = markInvoiceOnContact({ invoice: invoice(), status: "paid" })
    await settle()
    m.rows.set("901", "open")
    await markInvoiceCreated({ invoice: invoice({ id: "901" }) })
    m.rows.set("901", "paid")
    await markInvoiceOnContact({
      invoice: invoice({ id: "901" }),
      status: "paid",
    })
    release()
    await payA
    expect(field("invoice_last_id")).toBe("901")
    expect(field("invoice_last_status")).toBe("paid")
  })

  test("T2: a create's status write lands after a newer invoice was created and paid", async () => {
    m.rows.set("900", "paid")
    await markInvoiceCreated({ invoice: invoice() })
    m.rows.set("900", "open")
    const release = holdNextWrite("invoice_last_status")
    const createA = markInvoiceCreated({ invoice: invoice() })
    await settle()
    m.rows.set("901", "open")
    await markInvoiceCreated({ invoice: invoice({ id: "901" }) })
    m.rows.set("901", "paid")
    await markInvoiceOnContact({
      invoice: invoice({ id: "901" }),
      status: "paid",
    })
    release()
    await createA
    expect(field("invoice_last_id")).toBe("901")
    expect(field("invoice_last_status")).toBe("paid")
  })

  test("T3: a deposit mark lands after the balance paid the same invoice", async () => {
    await markInvoiceCreated({ invoice: invoice() })
    m.rows.set("900", "partiallyPaid")
    const release = holdNextWrite("invoice_last_status")
    const deposit = markInvoiceOnContact({
      invoice: invoice(),
      status: "partiallyPaid",
    })
    await settle()
    m.rows.set("900", "paid")
    await markInvoiceOnContact({ invoice: invoice(), status: "paid" })
    release()
    await deposit
    expect(field("invoice_last_status")).toBe("paid")
  })

  test("T4: a paid mark lands after its own refund rolled the row back", async () => {
    await markInvoiceCreated({ invoice: invoice() })
    m.rows.set("900", "paid")
    const release = holdNextWrite("invoice_last_status")
    const pay = markInvoiceOnContact({ invoice: invoice(), status: "paid" })
    await settle()
    m.rows.set("900", "open")
    await markInvoiceStatusOnContact({ invoice: invoice() })
    release()
    await pay
    expect(field("invoice_last_status")).toBe("open")
  })

  test("a failed-payment write that lands after the invoice was paid is corrected", async () => {
    await markInvoiceCreated({ invoice: invoice() })
    const release = holdNextWrite("invoice_last_status")
    const failed = markInvoiceOnContact({
      invoice: invoice(),
      status: "payment_failed",
    })
    await settle()
    m.rows.set("900", "paid")
    await markInvoiceOnContact({ invoice: invoice(), status: "paid" })
    release()
    await failed
    expect(field("invoice_last_status")).toBe("paid")
  })
})
