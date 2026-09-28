// @vitest-environment node

/**
 * Deposits (s216b) against a REAL Postgres: the Invoice row lock that
 * serialises every payment of one invoice, the InvoicePayment unique index,
 * the markedAt claim, and a signed checkout webhook end to end. Stripe is
 * mocked at the client (sessions.retrieve); the contact marks and emitters
 * are mocked; every row write is the real code.
 *
 *     DATABASE_URL=postgres://... pnpm --filter @chatbotx.io/business test:db
 */

import { db, sql } from "@chatbotx.io/database/client"
import { requireRealDatabaseUrl } from "@chatbotx.io/vitest-config/real-db"
import Stripe from "stripe"
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest"

const WEBHOOK_SECRET = "whsec_depositSuiteSecret0123456789ab"
const SECRET_KEY = ["sk", "test", "depositSuiteKey0123456789"].join("_")

const m = vi.hoisted(() => ({
  integrations: new Map<string, string>(),
  sessionRetrieve: vi.fn(),
  marks: vi.fn(async () => undefined),
  emitPaid: vi.fn(async () => undefined),
  emitPartiallyPaid: vi.fn(async () => undefined),
  token: 0,
  /** When set, claimPaymentMarks waits for it (a payment's marks run late). */
  claimGate: null as Promise<void> | null,
}))

vi.mock("../../src/integration-stripe/service", () => {
  const credentialsFor = (workspaceId: string, integrationId: string) => ({
    integrationId,
    workspaceId,
    accountId: "acct_dep",
    livemode: false,
    defaultMethod: "stripeCheckout",
    webhookEndpointId: "we_dep",
    webhookEventsVersion: 2,
    auth: {
      secretKey: ["sk", "test", "depositSuiteKey0123456789"].join("_"),
      webhookSecret: "whsec_depositSuiteSecret0123456789ab",
    },
  })
  const byWorkspace = (ws: string) => {
    const id = m.integrations.get(ws)
    return id ? credentialsFor(ws, id) : null
  }
  return {
    integrationStripeService: {
      credentialsByWorkspaceId: async (ws: string) => byWorkspace(ws),
      credentialsByWorkspaceIdOrFail: (ws: string) => {
        const credentials = byWorkspace(ws)
        return credentials
          ? Promise.resolve(credentials)
          : Promise.reject(new Error("Stripe is not connected"))
      },
      credentialsByIntegrationId: (integrationId: string) => {
        const entry = [...m.integrations].find(([, id]) => id === integrationId)
        return Promise.resolve(
          entry ? credentialsFor(entry[0], entry[1]) : null,
        )
      },
    },
  }
})
vi.mock("../../src/invoice/checkout-provider", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../src/invoice/checkout-provider")
  >()),
  prepareCheckoutInvoice: () => {
    m.token += 1
    const payToken = `DepositSuiteTok${String(m.token).padStart(7, "0")}`
    return Promise.resolve({
      providerCustomerId: "cus_dep",
      payToken,
      hostedUrl: `https://chat.example.org/pay/${payToken}`,
    })
  },
}))
vi.mock("../../src/invoice/payments", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/invoice/payments")>()
  return {
    ...actual,
    claimPaymentMarks: async (id: string) => {
      const gate = m.claimGate
      m.claimGate = null
      await gate
      return await actual.claimPaymentMarks(id)
    },
  }
})
vi.mock("../../src/integration-stripe/client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/integration-stripe/client")>()
  const real = new actual.Stripe(
    ["sk", "test", "depositSuiteKey0123456789"].join("_"),
  )
  return {
    ...actual,
    createStripeClient: () => ({
      webhooks: real.webhooks,
      checkout: {
        sessions: { retrieve: (...a: unknown[]) => m.sessionRetrieve(...a) },
      },
    }),
  }
})
vi.mock("../../src/invoice/contact-marks", () => ({
  markInvoiceOnContact: (...a: unknown[]) => m.marks(...(a as [])),
  markInvoiceCreated: vi.fn(async () => undefined),
}))
vi.mock("../../src/invoice/document", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/invoice/document")>()),
  prerenderInvoiceReceipt: vi.fn(async () => undefined),
}))
vi.mock("../../src/invoice/mirror", () => ({
  enqueueInvoiceMirror: vi.fn(async () => undefined),
}))
vi.mock("@chatbotx.io/events", () => ({
  emitInvoiceCreated: vi.fn(async () => undefined),
  emitInvoicePaid: (...a: unknown[]) => m.emitPaid(...(a as [])),
  emitInvoicePartiallyPaid: (...a: unknown[]) =>
    m.emitPartiallyPaid(...(a as [])),
  emitInvoicePaymentFailed: vi.fn(async () => undefined),
}))
vi.mock("../../src/audit/dispatcher", () => ({
  dispatchAuditRecord: vi.fn(async () => undefined),
}))

const databaseUrl = requireRealDatabaseUrl()

const { invoiceService } = await import("../../src/invoice/service")
const { handleStripeWebhook } = await import("../../src/invoice/stripe-webhook")
const { applyCheckoutPayment, claimPaymentMarks } = await import(
  "../../src/invoice/payments"
)
const signer = new Stripe(SECRET_KEY).webhooks

let nextId = 9_216_000_000_000_000n
const mintId = () => {
  nextId += 1n
  return nextId.toString()
}
const seeded: Record<string, string[]> = {
  Contact: [],
  Integration: [],
  Workspace: [],
}

async function asReplica(statement: ReturnType<typeof sql>): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`)
    await tx.execute(statement)
  })
}

async function seedWorkspace() {
  const workspaceId = mintId()
  const contactId = mintId()
  const integrationId = mintId()
  await asReplica(sql`
    INSERT INTO "Workspace" (id, name, "ownerId")
    VALUES (${workspaceId}, ${`s216b deposit ${workspaceId}`}, 1)`)
  seeded.Workspace?.push(workspaceId)
  await asReplica(sql`
    INSERT INTO "Contact" (id, "workspaceId") VALUES (${contactId}, ${workspaceId})`)
  seeded.Contact?.push(contactId)
  await asReplica(sql`
    INSERT INTO "Integration" (id, "workspaceId", "integrationType")
    VALUES (${integrationId}, ${workspaceId}, 'stripe')`)
  seeded.Integration?.push(integrationId)
  m.integrations.set(workspaceId, integrationId)
  return { workspaceId, contactId, integrationId }
}

/** A $200.00 stripeCheckout invoice offering a 25% ($50.00) deposit, opened. */
async function createDepositInvoice() {
  const { workspaceId, contactId } = await seedWorkspace()
  const invoice = await invoiceService.create({
    workspaceId,
    contactId,
    currency: "USD",
    dueDays: 7,
    method: "stripeCheckout",
    lines: [{ description: "Proof package", quantity: 1, unitAmount: "200" }],
    deposit: { type: "percent", value: "25" },
  })
  return { workspaceId, contactId, invoice }
}

const invoiceRow = async (id: string) =>
  await db.query.invoiceModel.findFirst({ where: { id } })
const paymentRows = async (invoiceId: string) =>
  await db.query.invoicePaymentModel.findMany({ where: { invoiceId } })

const apply = (
  invoiceId: string,
  kind: "full" | "deposit" | "balance",
  amountMinor: bigint,
  paymentIntentId: string,
) =>
  db.transaction((tx) =>
    applyCheckoutPayment(tx, {
      invoiceId,
      kind,
      amountMinor,
      paymentIntentId,
      now: new Date(),
    }),
  )

function signedCompleted(
  eventId: string,
  sessionId: string,
  type = "checkout.session.completed",
) {
  const payload = JSON.stringify({
    id: eventId,
    object: "event",
    api_version: "2026-05-27.dahlia",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    type,
    data: { object: { id: sessionId, object: "checkout.session" } },
  })
  return {
    rawBody: Buffer.from(payload),
    signature: signer.generateTestHeaderString({
      payload,
      secret: WEBHOOK_SECRET,
    }),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(async () => {
  if (!databaseUrl) {
    return
  }
  const workspaces = seeded.Workspace ?? []
  if (workspaces.length > 0) {
    const list = sql.join(
      workspaces.map((id) => sql`${id}`),
      sql`, `,
    )
    await asReplica(
      sql`DELETE FROM "InvoicePayment" WHERE "workspaceId" IN (${list})`,
    )
    await asReplica(
      sql`DELETE FROM "InvoiceEvent" WHERE "workspaceId" IN (${list})`,
    )
    await asReplica(
      sql`DELETE FROM "InvoiceLineItem" WHERE "invoiceId" IN (SELECT id FROM "Invoice" WHERE "workspaceId" IN (${list}))`,
    )
    await asReplica(sql`DELETE FROM "Invoice" WHERE "workspaceId" IN (${list})`)
  }
  for (const table of ["Contact", "Integration", "Workspace"]) {
    const ids = seeded[table]?.splice(0) ?? []
    if (ids.length > 0) {
      await asReplica(sql`
        DELETE FROM ${sql.identifier(table)}
         WHERE id IN (${sql.join(
           ids.map((id) => sql`${id}`),
           sql`, `,
         )})`)
    }
  }
  m.integrations.clear()
})

afterAll(async () => {
  if (databaseUrl) {
    await db.$client.end()
  }
})

describe.skipIf(!databaseUrl)("deposit create (real service)", () => {
  test("a 25% deposit on $200.00 stores the resolved $50.00 and opens", async () => {
    const { invoice } = await createDepositInvoice()
    expect(invoice).toMatchObject({
      status: "open",
      total: "200.00",
      depositType: "percent",
      depositValue: "25",
      depositAmount: "50.00",
      amountPaid: "0.00",
    })
  })

  test("a replay of the same key with the equivalent fixed deposit is the SAME request", async () => {
    const { workspaceId, contactId } = await seedWorkspace()
    const base = {
      workspaceId,
      contactId,
      currency: "USD",
      dueDays: 7,
      method: "stripeCheckout" as const,
      lines: [{ description: "Pkg", quantity: 1, unitAmount: "200" }],
      sourceKey: "api:dep-replay",
    }
    const first = await invoiceService.create({
      ...base,
      deposit: { type: "percent", value: "25" },
    })
    const second = await invoiceService.create({
      ...base,
      deposit: { type: "amount", value: "50.00" },
    })
    expect(second.id).toBe(first.id)
    await expect(
      invoiceService.create({
        ...base,
        deposit: { type: "amount", value: "60.00" },
      }),
    ).rejects.toMatchObject({ code: "conflict" })
  })

  test.each([
    [{ type: "percent", value: "100" }],
    [{ type: "percent", value: "0" }],
    [{ type: "amount", value: "200.00" }],
    [{ type: "amount", value: "0" }],
  ] as const)("deposit %j is refused 422 and writes no invoice", async (deposit) => {
    const { workspaceId, contactId } = await seedWorkspace()
    await expect(
      invoiceService.create({
        workspaceId,
        contactId,
        currency: "USD",
        dueDays: 7,
        method: "stripeCheckout",
        lines: [{ description: "Pkg", quantity: 1, unitAmount: "200" }],
        deposit: { ...deposit },
      }),
    ).rejects.toMatchObject({ code: "validation" })
    const [{ count } = { count: -1 }] = (
      await db.execute(
        sql`SELECT count(*)::int AS count FROM "Invoice" WHERE "workspaceId" = ${workspaceId}`,
      )
    ).rows as { count: number }[]
    expect(count).toBe(0)
  })

  test("a deposit on a stripeInvoice is refused: deposits need stripeCheckout", async () => {
    const { workspaceId, contactId } = await seedWorkspace()
    await expect(
      invoiceService.create({
        workspaceId,
        contactId,
        currency: "USD",
        dueDays: 7,
        method: "stripeInvoice",
        lines: [{ description: "Pkg", quantity: 1, unitAmount: "200" }],
        deposit: { type: "percent", value: "25" },
      }),
    ).rejects.toThrow("Deposits need the stripeCheckout method")
  })
})

describe.skipIf(!databaseUrl)("applyCheckoutPayment under the row lock", () => {
  test("deposit, then balance: partiallyPaid, then paid with two payment rows", async () => {
    const { invoice } = await createDepositInvoice()
    const deposit = await apply(invoice.id, "deposit", 5000n, "pi_dep")
    expect(deposit.kind).toBe("applied")
    expect(await invoiceRow(invoice.id)).toMatchObject({
      status: "partiallyPaid",
      amountPaid: "50.00",
      paidAt: null,
      checkoutSessionId: null,
    })
    const balance = await apply(invoice.id, "balance", 15000n, "pi_bal")
    expect(balance.kind).toBe("applied")
    expect(await invoiceRow(invoice.id)).toMatchObject({
      status: "paid",
      amountPaid: "200.00",
      providerInvoiceId: "pi_bal",
    })
    expect((await invoiceRow(invoice.id))?.paidAt).toBeInstanceOf(Date)
    const payments = await paymentRows(invoice.id)
    expect(payments.map((p) => [p.kind, p.amount]).sort()).toEqual([
      ["balance", "150.00"],
      ["deposit", "50.00"],
    ])
  })

  test("8 concurrent applies of ONE deposit PaymentIntent record it once", async () => {
    const { invoice } = await createDepositInvoice()
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        apply(invoice.id, "deposit", 5000n, "pi_dep"),
      ),
    )
    expect(results.filter((r) => r.kind === "applied")).toHaveLength(1)
    expect(results.filter((r) => r.kind === "known")).toHaveLength(7)
    expect(await paymentRows(invoice.id)).toHaveLength(1)
    expect((await invoiceRow(invoice.id))?.amountPaid).toBe("50.00")
  })

  test("a deposit and a FULL payment racing: exactly one applies, the other is rejected", async () => {
    for (let round = 0; round < 6; round += 1) {
      const { invoice } = await createDepositInvoice()
      const results = await Promise.all([
        apply(invoice.id, "deposit", 5000n, `pi_d${round}`),
        apply(invoice.id, "full", 20_000n, `pi_f${round}`),
      ])
      expect(results.filter((r) => r.kind === "applied")).toHaveLength(1)
      expect(results.filter((r) => r.kind === "rejected")).toHaveLength(1)
      const row = await invoiceRow(invoice.id)
      const payments = await paymentRows(invoice.id)
      expect(payments).toHaveLength(1)
      // The ledger and the row agree, whichever won.
      expect(row?.amountPaid).toBe(payments[0]?.amount)
    }
  })

  test("6 concurrent balance payments (different PaymentIntents) after a deposit: one applies", async () => {
    const { invoice } = await createDepositInvoice()
    await apply(invoice.id, "deposit", 5000n, "pi_dep")
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        apply(invoice.id, "balance", 15000n, `pi_bal${i}`),
      ),
    )
    expect(results.filter((r) => r.kind === "applied")).toHaveLength(1)
    expect(await paymentRows(invoice.id)).toHaveLength(2)
    expect((await invoiceRow(invoice.id))?.amountPaid).toBe("200.00")
  })

  test("8 concurrent mark claims of one payment: exactly one wins", async () => {
    const { invoice } = await createDepositInvoice()
    const applied = await apply(invoice.id, "deposit", 5000n, "pi_dep")
    if (applied.kind !== "applied") {
      throw new Error("deposit not applied")
    }
    const claims = await Promise.all(
      Array.from({ length: 8 }, () => claimPaymentMarks(applied.payment.id)),
    )
    expect(claims.filter(Boolean)).toHaveLength(1)
  })

  test("a partly paid invoice cannot be voided", async () => {
    const { workspaceId, invoice } = await createDepositInvoice()
    await apply(invoice.id, "deposit", 5000n, "pi_dep")
    await expect(
      invoiceService.void({ workspaceId, id: invoice.id }),
    ).rejects.toThrow("A deposit was paid")
    expect((await invoiceRow(invoice.id))?.status).toBe("partiallyPaid")
  })
})

describe.skipIf(!databaseUrl)("signed checkout webhook, end to end", () => {
  const session = (
    invoice: { id: string; workspaceId: string },
    kind: string,
    minor: number,
    pi: string,
  ) => ({
    id: `cs_${pi}`,
    object: "checkout.session",
    mode: "payment",
    status: "complete",
    payment_status: "paid",
    amount_total: minor,
    currency: "usd",
    payment_intent: pi,
    metadata: {
      hub_invoice_id: invoice.id,
      hub_workspace_id: invoice.workspaceId,
      hub_payment_kind: kind,
      hub_payment_minor: String(minor),
    },
  })

  test("deposit then balance through the webhook; 8 concurrent redeliveries apply and mark once", async () => {
    const { invoice } = await createDepositInvoice()
    const integrationId = m.integrations.get(invoice.workspaceId) as string
    m.sessionRetrieve.mockResolvedValue(
      session(invoice, "deposit", 5000, "pi_wdep"),
    )
    const deliveries = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        handleStripeWebhook({
          integrationId,
          ...signedCompleted(i < 4 ? "evt_wdep" : `evt_wdep_${i}`, "cs_x"),
        }),
      ),
    )
    expect(deliveries.filter((d) => d.outcome === "applied")).toHaveLength(1)
    expect(m.emitPartiallyPaid).toHaveBeenCalledTimes(1)
    expect(m.emitPaid).not.toHaveBeenCalled()
    expect(await invoiceRow(invoice.id)).toMatchObject({
      status: "partiallyPaid",
      amountPaid: "50.00",
    })

    m.sessionRetrieve.mockResolvedValue(
      session(invoice, "balance", 15_000, "pi_wbal"),
    )
    const balance = await handleStripeWebhook({
      integrationId,
      ...signedCompleted("evt_wbal", "cs_y"),
    })
    expect(balance.outcome).toBe("applied")
    expect(m.emitPaid).toHaveBeenCalledTimes(1)
    expect(await invoiceRow(invoice.id)).toMatchObject({
      status: "paid",
      amountPaid: "200.00",
    })
    const payments = await paymentRows(invoice.id)
    expect(payments.every((p) => p.markedAt instanceof Date)).toBe(true)
  })

  test("a full payment landing after a deposit is flagged, never applied", async () => {
    const { invoice } = await createDepositInvoice()
    const integrationId = m.integrations.get(invoice.workspaceId) as string
    m.sessionRetrieve.mockResolvedValue(
      session(invoice, "deposit", 5000, "pi_d2"),
    )
    await handleStripeWebhook({
      integrationId,
      ...signedCompleted("evt_d2", "cs_d2"),
    })
    m.sessionRetrieve.mockResolvedValue(
      session(invoice, "full", 20_000, "pi_f2"),
    )
    const late = await handleStripeWebhook({
      integrationId,
      ...signedCompleted("evt_f2", "cs_f2"),
    })
    expect(late).toEqual({ outcome: "noop", detail: "duplicate-payment" })
    const row = await invoiceRow(invoice.id)
    expect(row).toMatchObject({ status: "partiallyPaid", amountPaid: "50.00" })
    expect(row?.lastError).toContain("pi_f2")
    expect(await paymentRows(invoice.id)).toHaveLength(1)
  })

  test("probe H1: completed + async_payment_succeeded of one deposit, concurrently x10: never a deadlock, never a retry", async () => {
    for (let round = 0; round < 10; round += 1) {
      const { invoice } = await createDepositInvoice()
      const integrationId = m.integrations.get(invoice.workspaceId) as string
      m.sessionRetrieve.mockResolvedValue(
        session(invoice, "deposit", 5000, `pi_h1_${round}`),
      )
      const results = await Promise.all([
        handleStripeWebhook({
          integrationId,
          ...signedCompleted(`evt_h1a_${round}`, "cs_h1"),
        }),
        handleStripeWebhook({
          integrationId,
          ...signedCompleted(
            `evt_h1b_${round}`,
            "cs_h1",
            "checkout.session.async_payment_succeeded",
          ),
        }),
      ])
      expect(results.map((r) => r.outcome).sort()).toEqual(["applied", "noop"])
      expect((await invoiceRow(invoice.id))?.amountPaid).toBe("50.00")
    }
  })

  test("probe H2: a deposit whose marks run AFTER the balance paid never marks partiallyPaid", async () => {
    const { invoice } = await createDepositInvoice()
    const integrationId = m.integrations.get(invoice.workspaceId) as string
    let release: () => void = () => undefined
    m.claimGate = new Promise((resolve) => {
      release = resolve
    })
    m.sessionRetrieve.mockResolvedValueOnce(
      session(invoice, "deposit", 5000, "pi_h2d"),
    )
    const deposit = handleStripeWebhook({
      integrationId,
      ...signedCompleted("evt_h2d", "cs_h2d"),
    })
    // The deposit is applied and parked at its marks claim; the balance lands.
    await vi.waitFor(async () => {
      expect((await invoiceRow(invoice.id))?.status).toBe("partiallyPaid")
    })
    m.sessionRetrieve.mockResolvedValueOnce(
      session(invoice, "balance", 15_000, "pi_h2b"),
    )
    const balance = await handleStripeWebhook({
      integrationId,
      ...signedCompleted("evt_h2b", "cs_h2b"),
    })
    expect(balance.outcome).toBe("applied")
    release()
    await deposit
    expect(m.marks).toHaveBeenCalledTimes(1)
    expect(m.marks).toHaveBeenCalledWith(
      expect.objectContaining({ status: "paid" }),
    )
    expect(m.emitPartiallyPaid).not.toHaveBeenCalled()
  })

  test("probe H3: a flagged payment's 'refund it' warning survives the next applied payment", async () => {
    const { invoice } = await createDepositInvoice()
    const integrationId = m.integrations.get(invoice.workspaceId) as string
    for (const [kind, minor, pi] of [
      ["deposit", 5000, "pi_h3d"],
      ["full", 20_000, "pi_h3f"],
      ["balance", 15_000, "pi_h3b"],
    ] as const) {
      m.sessionRetrieve.mockResolvedValue(session(invoice, kind, minor, pi))
      await handleStripeWebhook({
        integrationId,
        ...signedCompleted(`evt_${pi}`, `cs_${pi}`),
      })
    }
    const row = await invoiceRow(invoice.id)
    expect(row).toMatchObject({ status: "paid", amountPaid: "200.00" })
    expect(row?.lastError).toContain("pi_h3f")
  })
})
