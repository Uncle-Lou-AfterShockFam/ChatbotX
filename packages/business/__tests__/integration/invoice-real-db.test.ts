// @vitest-environment node

/**
 * Hub invoicing (s205b) against a REAL Postgres: the per-workspace advisory
 * lock that numbers invoices and arbitrates a sourceKey replay, the
 * InvoiceEvent unique index that dedups concurrent webhook deliveries, and
 * the status CAS. Stripe is mocked (finalizeWithStripe returns an open
 * invoice; the webhook client verifies a REAL signature and retrieve says
 * paid), as are the contact marks and the event emitters; every row write
 * is the real service code.
 *
 * Seeds (Workspace, Contact, Integration) run under
 * `SET LOCAL session_replication_role = replica` and everything is deleted
 * afterwards. Run with
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

const WEBHOOK_SECRET = "whsec_realDbSuiteSecret0123456789ab"
const SECRET_KEY = ["sk", "test", "realDbSuiteKey0123456789"].join("_")

const m = vi.hoisted(() => ({
  /** workspaceId -> integrationId, read by the credentials mocks. */
  integrations: new Map<string, string>(),
  finalize: vi.fn(),
  retrieve: vi.fn(),
  marks: vi.fn(),
  emitPaid: vi.fn(),
}))

vi.mock("../../src/integration-stripe/service", () => {
  const credentialsFor = (workspaceId: string, integrationId: string) => ({
    integrationId,
    workspaceId,
    livemode: false,
    auth: {
      secretKey: ["sk", "test", "realDbSuiteKey0123456789"].join("_"),
      webhookSecret: "whsec_realDbSuiteSecret0123456789ab",
    },
  })
  const byWorkspace = (workspaceId: string) => {
    const integrationId = m.integrations.get(workspaceId)
    return integrationId ? credentialsFor(workspaceId, integrationId) : null
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
vi.mock("../../src/invoice/stripe-provider", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../src/invoice/stripe-provider")
  >()),
  finalizeWithStripe: (...a: unknown[]) => m.finalize(...a),
}))
vi.mock("../../src/integration-stripe/client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/integration-stripe/client")>()
  const real = new actual.Stripe(
    ["sk", "test", "realDbSuiteKey0123456789"].join("_"),
  )
  return {
    ...actual,
    createStripeClient: () => ({
      webhooks: real.webhooks,
      invoices: { retrieve: (...a: unknown[]) => m.retrieve(...a) },
      invoicePayments: { list: vi.fn() },
    }),
  }
})
vi.mock("../../src/invoice/contact-marks", () => ({
  markInvoiceOnContact: (...a: unknown[]) => m.marks(...a),
  markInvoiceCreated: vi.fn(),
}))
vi.mock("@chatbotx.io/events", () => ({
  emitInvoiceCreated: vi.fn(async () => undefined),
  emitInvoicePaid: (...a: unknown[]) => m.emitPaid(...a),
  emitInvoicePaymentFailed: vi.fn(async () => undefined),
}))
vi.mock("../../src/audit/dispatcher", () => ({
  dispatchAuditRecord: vi.fn(async () => undefined),
}))

const databaseUrl = requireRealDatabaseUrl()

const { invoiceService } = await import("../../src/invoice/service")
const { handleStripeWebhook } = await import("../../src/invoice/stripe-webhook")
const signer = new Stripe(SECRET_KEY).webhooks

/** Ids far above any snowflake a scratch database would hold (own range). */
let nextId = 9_205_000_000_000_000n
function mintId(): string {
  nextId += 1n
  return nextId.toString()
}

const seededWorkspaces: string[] = []
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

/** A workspace with one contact and a connected (mocked) Stripe integration. */
async function seedWorkspace() {
  const workspaceId = mintId()
  const contactId = mintId()
  const integrationId = mintId()
  await asReplica(sql`
    INSERT INTO "Workspace" (id, name, "ownerId")
    VALUES (${workspaceId}, ${`s205b invoice ${workspaceId}`}, 1)`)
  seeded.Workspace?.push(workspaceId)
  seededWorkspaces.push(workspaceId)
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

const createInput = (
  workspaceId: string,
  contactId: string,
  extra: Record<string, unknown> = {},
) => ({
  workspaceId,
  contactId,
  currency: "USD",
  dueDays: 7,
  lines: [{ description: "Session", quantity: 2, unitAmount: "12.50" }],
  ...extra,
})

async function countRows(
  table: "Invoice" | "InvoiceEvent" | "InvoiceLineItem",
  workspaceId: string,
): Promise<number> {
  const result =
    table === "InvoiceLineItem"
      ? await db.execute<{ n: string }>(sql`
          SELECT count(*)::text AS n FROM "InvoiceLineItem" l
            JOIN "Invoice" i ON i.id = l."invoiceId"
           WHERE i."workspaceId" = ${workspaceId}`)
      : await db.execute<{ n: string }>(sql`
          SELECT count(*)::text AS n FROM ${sql.identifier(table)}
           WHERE "workspaceId" = ${workspaceId}`)
  return Number(result.rows[0]?.n ?? 0)
}

beforeEach(() => {
  vi.clearAllMocks()
  // Deterministic provider: every finalize opens the Stripe invoice.
  m.finalize.mockImplementation(async (props: { invoice: { id: string } }) => ({
    providerInvoiceId: `in_rdb_${props.invoice.id}`,
    providerCustomerId: "cus_rdb",
    hostedUrl: `https://invoice.stripe.com/i/${props.invoice.id}`,
    pdfUrl: null,
    dueAt: null,
    status: "open",
  }))
  m.marks.mockResolvedValue(undefined)
  m.emitPaid.mockResolvedValue(undefined)
})

afterEach(async () => {
  if (!databaseUrl) {
    return
  }
  const workspaces = seededWorkspaces.splice(0)
  if (workspaces.length > 0) {
    const list = sql.join(
      workspaces.map((id) => sql`${id}`),
      sql`, `,
    )
    // Children first; the Invoice FKs cascade anyway, this keeps it explicit.
    await asReplica(
      sql`DELETE FROM "InvoiceEvent" WHERE "workspaceId" IN (${list})`,
    )
    await asReplica(sql`
      DELETE FROM "InvoiceLineItem" WHERE "invoiceId" IN
        (SELECT id FROM "Invoice" WHERE "workspaceId" IN (${list}))`)
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
  if (!databaseUrl) {
    return
  }
  await db.$client.end()
})

describe.skipIf(!databaseUrl)("invoiceService.create under concurrency", () => {
  test("10 concurrent creates in one workspace get numbers 1..10, no gaps, no dupes", async () => {
    const { workspaceId, contactId } = await seedWorkspace()
    const invoices = await Promise.all(
      Array.from({ length: 10 }, () =>
        invoiceService.create(createInput(workspaceId, contactId)),
      ),
    )
    expect(invoices.map((i) => i.number).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ])
    expect(new Set(invoices.map((i) => i.id)).size).toBe(10)
    expect(invoices.every((i) => i.status === "open")).toBe(true)
    expect(invoices.every((i) => i.total === "25.00")).toBe(true)
    expect(await countRows("Invoice", workspaceId)).toBe(10)
    expect(await countRows("InvoiceLineItem", workspaceId)).toBe(10)
    expect(m.finalize).toHaveBeenCalledTimes(10)
  })

  test("numbering is per workspace: a second workspace starts at 1", async () => {
    const a = await seedWorkspace()
    const b = await seedWorkspace()
    await invoiceService.create(createInput(a.workspaceId, a.contactId))
    await invoiceService.create(createInput(a.workspaceId, a.contactId))
    const first = await invoiceService.create(
      createInput(b.workspaceId, b.contactId),
    )
    expect(first.number).toBe(1)
  })

  test("5 concurrent creates with the same sourceKey produce ONE invoice row", async () => {
    const { workspaceId, contactId } = await seedWorkspace()
    const invoices = await Promise.all(
      Array.from({ length: 5 }, () =>
        invoiceService.create(
          createInput(workspaceId, contactId, { sourceKey: "flow-run-42" }),
        ),
      ),
    )
    expect(new Set(invoices.map((i) => i.id)).size).toBe(1)
    expect(await countRows("Invoice", workspaceId)).toBe(1)
    expect(await countRows("InvoiceLineItem", workspaceId)).toBe(1)
    expect(invoices[0]?.number).toBe(1)
  })

  test("a contact of another workspace is not found and writes nothing", async () => {
    const a = await seedWorkspace()
    const b = await seedWorkspace()
    await expect(
      invoiceService.create(createInput(a.workspaceId, b.contactId)),
    ).rejects.toMatchObject({ code: "notFound" })
    expect(await countRows("Invoice", a.workspaceId)).toBe(0)
  })
})

describe.skipIf(!databaseUrl)(
  "handleStripeWebhook dedup on the real index",
  () => {
    test("5 concurrent deliveries of one event apply ONE transition and write ONE InvoiceEvent", async () => {
      const { workspaceId, contactId, integrationId } = await seedWorkspace()
      const invoice = await invoiceService.create(
        createInput(workspaceId, contactId),
      )
      expect(invoice.status).toBe("open")
      m.retrieve.mockResolvedValue({
        id: invoice.providerInvoiceId,
        object: "invoice",
        status: "paid",
        metadata: { hub_invoice_id: invoice.id },
      })
      const payload = JSON.stringify({
        id: `evt_rdb_${invoice.id}`,
        object: "event",
        api_version: "2026-05-27.dahlia",
        created: Math.floor(Date.now() / 1000),
        livemode: false,
        type: "invoice.paid",
        data: {
          object: { id: invoice.providerInvoiceId, object: "invoice" },
        },
      })
      const deliver = () =>
        handleStripeWebhook({
          integrationId,
          rawBody: Buffer.from(payload),
          signature: signer.generateTestHeaderString({
            payload,
            secret: WEBHOOK_SECRET,
          }),
        })

      const results = await Promise.all(Array.from({ length: 5 }, deliver))
      const outcomes = results.map((r) => r.outcome).sort()
      expect(outcomes).toEqual([
        "applied",
        "duplicate",
        "duplicate",
        "duplicate",
        "duplicate",
      ])
      expect(await countRows("InvoiceEvent", workspaceId)).toBe(1)
      const stored = await invoiceService.get({ workspaceId, id: invoice.id })
      expect(stored.status).toBe("paid")
      expect(stored.paidAt).toBeInstanceOf(Date)
      expect(m.marks).toHaveBeenCalledTimes(1)
      expect(m.emitPaid).toHaveBeenCalledTimes(1)

      // A sixth, later redelivery is still a duplicate.
      expect((await deliver()).outcome).toBe("duplicate")
      expect(m.marks).toHaveBeenCalledTimes(1)
    })

    test("a failed mark deletes the dedup row, so the redelivery re-runs the marks once", async () => {
      const { workspaceId, contactId, integrationId } = await seedWorkspace()
      const invoice = await invoiceService.create(
        createInput(workspaceId, contactId),
      )
      m.retrieve.mockResolvedValue({
        id: invoice.providerInvoiceId,
        object: "invoice",
        status: "paid",
        metadata: { hub_invoice_id: invoice.id },
      })
      const payload = JSON.stringify({
        id: `evt_rdb_marks_${invoice.id}`,
        object: "event",
        created: Math.floor(Date.now() / 1000),
        livemode: false,
        type: "invoice.paid",
        data: { object: { id: invoice.providerInvoiceId, object: "invoice" } },
      })
      const deliver = () =>
        handleStripeWebhook({
          integrationId,
          rawBody: Buffer.from(payload),
          signature: signer.generateTestHeaderString({
            payload,
            secret: WEBHOOK_SECRET,
          }),
        })
      m.marks.mockRejectedValueOnce(new Error("custom field write failed"))
      expect((await deliver()).outcome).toBe("retry")
      expect(await countRows("InvoiceEvent", workspaceId)).toBe(0)
      // The transition itself committed before the marks ran.
      expect(
        (await invoiceService.get({ workspaceId, id: invoice.id })).status,
      ).toBe("paid")

      expect((await deliver()).outcome).toBe("noop")
      expect(m.marks).toHaveBeenCalledTimes(2)
      expect(m.emitPaid).toHaveBeenCalledTimes(1)
      expect(await countRows("InvoiceEvent", workspaceId)).toBe(1)
    })
  },
)

describe.skipIf(!databaseUrl)("invoiceService.transition CAS", () => {
  test("paid -> open and paid -> draft return null; the row stays paid", async () => {
    const { workspaceId, contactId } = await seedWorkspace()
    const invoice = await invoiceService.create(
      createInput(workspaceId, contactId),
    )
    const paid = await invoiceService.transition({
      invoiceId: invoice.id,
      to: "paid",
      set: { paidAt: new Date() },
    })
    expect(paid?.status).toBe("paid")
    expect(
      await invoiceService.transition({ invoiceId: invoice.id, to: "open" }),
    ).toBeNull()
    expect(
      await invoiceService.transition({ invoiceId: invoice.id, to: "draft" }),
    ).toBeNull()
    expect(
      await invoiceService.transition({ invoiceId: invoice.id, to: "void" }),
    ).toBeNull()
    expect(
      (await invoiceService.get({ workspaceId, id: invoice.id })).status,
    ).toBe("paid")
    // The one exit from paid is refunded.
    expect(
      (
        await invoiceService.transition({
          invoiceId: invoice.id,
          to: "refunded",
        })
      )?.status,
    ).toBe("refunded")
  })

  test("void() on a paid invoice rejects and never calls Stripe", async () => {
    const { workspaceId, contactId } = await seedWorkspace()
    const invoice = await invoiceService.create(
      createInput(workspaceId, contactId),
    )
    await invoiceService.transition({ invoiceId: invoice.id, to: "paid" })
    await expect(
      invoiceService.void({ workspaceId, id: invoice.id }),
    ).rejects.toMatchObject({ code: "validation" })
  })
})
