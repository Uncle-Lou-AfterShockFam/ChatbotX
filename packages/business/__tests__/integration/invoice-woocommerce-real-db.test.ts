// @vitest-environment node

/**
 * The WooCommerce payment webhook (s211b) against a REAL Postgres: the
 * InvoiceEvent unique index is the dedup and the status CAS is the only
 * writer. Pinned: 8 concurrent deliveries of one `order.paid` apply ONCE (one
 * event row, one set of marks); two sites whose order ids collide never touch
 * each other's invoices; a draft whose finalize never recorded the order is
 * adopted by its payment; a payment of an invoice voided here is flagged on
 * the event and the invoice, and the invoice stays void. The site
 * credentials lookup (encryption) and the contact marks are mocked.
 *
 *     DATABASE_URL=postgres://... pnpm --filter @chatbotx.io/business test:db
 */

import { createHmac, randomBytes } from "node:crypto"
import { db, sql } from "@chatbotx.io/database/client"
import { requireRealDatabaseUrl } from "@chatbotx.io/vitest-config/real-db"
import { afterAll, afterEach, describe, expect, test, vi } from "vitest"

const m = vi.hoisted(() => ({
  sites: new Map<string, { workspaceId: string; webhookSecret: string }>(),
  marks: vi.fn(async () => undefined),
  emitPaid: vi.fn(async () => undefined),
}))

vi.mock("../../src/integration-woocommerce/service", () => ({
  integrationWooCommerceService: {
    credentialsByIntegrationId: (integrationId: string) => {
      const site = m.sites.get(integrationId)
      return Promise.resolve(
        site
          ? {
              integrationId,
              workspaceId: site.workspaceId,
              siteSlug: `site-${integrationId}`,
              siteUrl: "https://shop.example.org",
              currency: "USD",
              auth: { actionToken: "btc_x", webhookSecret: site.webhookSecret },
            }
          : null,
      )
    },
  },
}))
vi.mock("../../src/invoice/contact-marks", () => ({
  markInvoiceOnContact: m.marks,
  markInvoiceCreated: vi.fn(async () => undefined),
}))
vi.mock("@chatbotx.io/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chatbotx.io/events")>()),
  emitInvoicePaid: m.emitPaid,
  emitInvoiceCreated: vi.fn(async () => undefined),
  emitInvoicePaymentFailed: vi.fn(async () => undefined),
}))
vi.mock("../../src/audit/dispatcher", () => ({
  dispatchAuditRecord: vi.fn(async () => undefined),
}))

const databaseUrl = requireRealDatabaseUrl()

const { handleWooCommerceWebhook } = await import(
  "../../src/invoice/woocommerce-webhook"
)

let nextId = 9_211_000_000_000_000n
function mintId(): string {
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
  await asReplica(sql`
    INSERT INTO "Workspace" (id, name, "ownerId")
    VALUES (${workspaceId}, ${`s211b woocommerce ${workspaceId}`}, 1)`)
  seeded.Workspace?.push(workspaceId)
  await asReplica(sql`
    INSERT INTO "Contact" (id, "workspaceId") VALUES (${contactId}, ${workspaceId})`)
  seeded.Contact?.push(contactId)
  return { workspaceId, contactId }
}

async function seedSite(workspaceId: string) {
  const integrationId = mintId()
  await asReplica(sql`
    INSERT INTO "Integration" (id, "workspaceId", "integrationType")
    VALUES (${integrationId}, ${workspaceId}, 'woocommerce')`)
  seeded.Integration?.push(integrationId)
  const webhookSecret = `whsec_${randomBytes(32).toString("base64")}`
  m.sites.set(integrationId, { workspaceId, webhookSecret })
  return { integrationId, webhookSecret }
}

async function seedInvoice(props: {
  workspaceId: string
  contactId: string
  integrationId: string
  number: number
  status?: string
  providerInvoiceId: string | null
}) {
  const invoiceId = mintId()
  await asReplica(sql`
    INSERT INTO "Invoice" (id, "workspaceId", number, status, method, currency,
      total, "contactId", "integrationId", "providerInvoiceId", "hostedUrl")
    VALUES (${invoiceId}, ${props.workspaceId}, ${props.number},
      ${props.status ?? "open"}, 'woocommerce', 'USD', '42.50',
      ${props.contactId}, ${props.integrationId}, ${props.providerInvoiceId},
      'https://shop.example.org/checkout/order-pay/3701/')`)
  return invoiceId
}

function deliver(props: {
  integrationId: string
  secret: string
  orderId: string
  hubInvoiceId: string
  event?: string
}) {
  const event = props.event ?? "order.paid"
  const id = `hc-order-${props.orderId}-${event.slice(6)}`
  const body = JSON.stringify({
    spec: "hub-connector/1",
    id,
    event,
    occurred_at: "2026-09-27T01:00:00Z",
    site: { slug: "shop", url: "https://shop.example.org/" },
    contact: { phone: "+15550004242" },
    subject: { type: "order", id: props.orderId, title: "Order" },
    fields: { order_id: props.orderId, hub_invoice_id: props.hubInvoiceId },
  })
  const ts = Math.floor(Date.now() / 1000)
  const key = Buffer.from(props.secret.slice("whsec_".length), "base64")
  const signature = `v1,${createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64")}`
  return handleWooCommerceWebhook({
    integrationId: props.integrationId,
    rawBody: Buffer.from(body),
    headers: { id, timestamp: String(ts), signature },
  })
}

async function invoiceRow(invoiceId: string) {
  const result = await db.execute<{
    status: string
    providerInvoiceId: string | null
    lastError: string | null
  }>(sql`
    SELECT status, "providerInvoiceId", "lastError"
      FROM "Invoice" WHERE id = ${invoiceId}`)
  return result.rows[0]
}

async function eventRows(integrationId: string) {
  const result = await db.execute<{ outcome: string; invoiceId: string }>(sql`
    SELECT outcome, "invoiceId" FROM "InvoiceEvent"
     WHERE "integrationId" = ${integrationId}`)
  return result.rows
}

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
      sql`DELETE FROM "InvoiceEvent" WHERE "workspaceId" IN (${list})`,
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
  m.sites.clear()
  m.marks.mockClear()
  m.emitPaid.mockClear()
})

afterAll(async () => {
  if (!databaseUrl) {
    return
  }
  await db.$client.end()
})

describe.skipIf(!databaseUrl)("WooCommerce payment webhook (s211b)", () => {
  test("8 concurrent deliveries of one order.paid apply once", async () => {
    const { workspaceId, contactId } = await seedWorkspace()
    const site = await seedSite(workspaceId)
    const invoiceId = await seedInvoice({
      workspaceId,
      contactId,
      integrationId: site.integrationId,
      number: 1,
      providerInvoiceId: `wc:${site.integrationId}:3701`,
    })
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        deliver({
          integrationId: site.integrationId,
          secret: site.webhookSecret,
          orderId: "3701",
          hubInvoiceId: invoiceId,
        }),
      ),
    )
    const reasons = results.map((r) => r.reason).sort()
    expect(reasons.filter((r) => r === "applied")).toHaveLength(1)
    expect(reasons.filter((r) => r === "duplicate")).toHaveLength(7)
    expect((await invoiceRow(invoiceId))?.status).toBe("paid")
    expect(await eventRows(site.integrationId)).toHaveLength(1)
    expect(m.marks).toHaveBeenCalledTimes(1)
    expect(m.emitPaid).toHaveBeenCalledTimes(1)
  })

  test("two sites with the same order id never touch each other's invoices", async () => {
    const { workspaceId, contactId } = await seedWorkspace()
    const a = await seedSite(workspaceId)
    const b = await seedSite(workspaceId)
    const invoiceA = await seedInvoice({
      workspaceId,
      contactId,
      integrationId: a.integrationId,
      number: 1,
      providerInvoiceId: `wc:${a.integrationId}:3701`,
    })
    const invoiceB = await seedInvoice({
      workspaceId,
      contactId,
      integrationId: b.integrationId,
      number: 2,
      providerInvoiceId: `wc:${b.integrationId}:3701`,
    })
    // Site B, correctly signed, names site A's invoice: not its order.
    const forged = await deliver({
      integrationId: b.integrationId,
      secret: b.webhookSecret,
      orderId: "3701",
      hubInvoiceId: invoiceA,
    })
    expect(forged.reason).toBe("captured")
    expect((await invoiceRow(invoiceA))?.status).toBe("open")
    // Site A's own payment of the same order id moves only A's invoice.
    const paid = await deliver({
      integrationId: a.integrationId,
      secret: a.webhookSecret,
      orderId: "3701",
      hubInvoiceId: invoiceA,
    })
    expect(paid.reason).toBe("applied")
    expect((await invoiceRow(invoiceA))?.status).toBe("paid")
    expect((await invoiceRow(invoiceB))?.status).toBe("open")
    // Site B's event id equals site A's (the dedup is per site), and its
    // unmatched delivery above burned nothing: B's own payment applies.
    const bPaid = await deliver({
      integrationId: b.integrationId,
      secret: b.webhookSecret,
      orderId: "3701",
      hubInvoiceId: invoiceB,
    })
    expect(bPaid.reason).toBe("applied")
    expect((await invoiceRow(invoiceB))?.status).toBe("paid")
    expect((await invoiceRow(invoiceA))?.status).toBe("paid")
  })

  test("a draft whose finalize never recorded the order is adopted by its payment", async () => {
    const { workspaceId, contactId } = await seedWorkspace()
    const site = await seedSite(workspaceId)
    const invoiceId = await seedInvoice({
      workspaceId,
      contactId,
      integrationId: site.integrationId,
      number: 1,
      status: "draft",
      providerInvoiceId: null,
    })
    const result = await deliver({
      integrationId: site.integrationId,
      secret: site.webhookSecret,
      orderId: "3702",
      hubInvoiceId: invoiceId,
    })
    expect(result.reason).toBe("applied")
    expect(await invoiceRow(invoiceId)).toMatchObject({
      status: "paid",
      providerInvoiceId: `wc:${site.integrationId}:3702`,
    })
  })

  test("a payment of an invoice voided here is flagged, never applied", async () => {
    const { workspaceId, contactId } = await seedWorkspace()
    const site = await seedSite(workspaceId)
    const invoiceId = await seedInvoice({
      workspaceId,
      contactId,
      integrationId: site.integrationId,
      number: 1,
      status: "void",
      providerInvoiceId: `wc:${site.integrationId}:3703`,
    })
    const result = await deliver({
      integrationId: site.integrationId,
      secret: site.webhookSecret,
      orderId: "3703",
      hubInvoiceId: invoiceId,
    })
    expect(result.reason).toBe("captured")
    const row = await invoiceRow(invoiceId)
    expect(row?.status).toBe("void")
    expect(row?.lastError).toContain("refund it in WooCommerce")
    expect(await eventRows(site.integrationId)).toEqual([
      { outcome: "paid-after-void", invoiceId },
    ])
    expect(m.marks).not.toHaveBeenCalled()
  })
})
