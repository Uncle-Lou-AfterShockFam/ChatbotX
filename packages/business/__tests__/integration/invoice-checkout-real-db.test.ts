// @vitest-environment node

/**
 * stripeCheckout (s207b) against a REAL Postgres: the `checkoutGeneration`
 * claim CAS and the record CAS under concurrent `/pay` visits, and a void
 * racing them. Stripe is a fake that honours Idempotency-Keys the way Stripe
 * does (one key is serialised; the same key with the same body returns the
 * same session). What is pinned: however many visits race, at most ONE
 * session of the invoice is ever open, every visit that gets a link gets
 * that one, and a void leaves none open.
 *
 *     DATABASE_URL=postgres://... pnpm --filter @chatbotx.io/business test:db
 */

import { db, sql } from "@chatbotx.io/database/client"
import { requireRealDatabaseUrl } from "@chatbotx.io/vitest-config/real-db"
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest"

const TOKEN_A = "RDBcheckout0000000000A"

const m = vi.hoisted(() => {
  type Session = Record<string, unknown> & { id: string; status: string }
  const stripe = {
    sessions: new Map<string, Session>(),
    keys: new Map<string, { body: string; id: string }>(),
    creates: 0,
    counter: 0,
  }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 2))
  const sessionsApi = {
    create: async (
      params: Record<string, unknown>,
      opts: { idempotencyKey: string },
    ) => {
      await tick()
      const body = JSON.stringify(params)
      const seen = stripe.keys.get(opts.idempotencyKey)
      if (seen) {
        if (seen.body !== body) {
          throw new Error("idempotency key reused with different parameters")
        }
        return { ...stripe.sessions.get(seen.id) }
      }
      stripe.creates += 1
      stripe.counter += 1
      const id = `cs_rdb_${stripe.counter}`
      const lines = params.line_items as {
        quantity: number
        price_data: { unit_amount: number; currency: string }
      }[]
      const session: Session = {
        id,
        status: "open",
        url: `https://checkout.stripe.com/c/pay/${id}`,
        expires_at: params.expires_at,
        amount_total: lines.reduce(
          (s, l) => s + l.quantity * l.price_data.unit_amount,
          0,
        ),
        currency: lines[0]?.price_data.currency,
      }
      stripe.sessions.set(id, session)
      stripe.keys.set(opts.idempotencyKey, { body, id })
      return { ...session }
    },
    retrieve: async (id: string) => {
      await tick()
      const session = stripe.sessions.get(id)
      if (!session) {
        throw new Error(`No such checkout session: ${id}`)
      }
      return { ...session }
    },
    expire: async (id: string) => {
      await tick()
      const session = stripe.sessions.get(id)
      if (session?.status !== "open") {
        throw new Error("Only open sessions can be expired")
      }
      session.status = "expired"
      return { ...session }
    },
  }
  return { stripe, sessionsApi, integrations: new Map<string, string>() }
})

vi.mock("../../src/integration-stripe/service", () => {
  const credentialsFor = (workspaceId: string, integrationId: string) => ({
    integrationId,
    workspaceId,
    accountId: "acct_rdb",
    livemode: false,
    defaultMethod: "stripeCheckout",
    webhookEndpointId: "we_rdb",
    webhookEventsVersion: 2,
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
      credentialsByWorkspaceIdOrFail: async (ws: string) => {
        const credentials = byWorkspace(ws)
        if (!credentials) {
          throw new Error("Stripe is not connected")
        }
        return credentials
      },
      ensureWebhookEvents: async () => undefined,
    },
  }
})
vi.mock("../../src/integration-stripe/client", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../src/integration-stripe/client")
  >()),
  createStripeClient: () => ({ checkout: { sessions: m.sessionsApi } }),
}))
vi.mock("../../src/platform/settings", () => ({
  resolveWorkspaceAppUrl: async () => "https://chat.example.org",
}))
vi.mock("@chatbotx.io/events", () => ({
  emitInvoiceCreated: vi.fn(async () => undefined),
  emitInvoicePaid: vi.fn(async () => undefined),
  emitInvoicePaymentFailed: vi.fn(async () => undefined),
}))
vi.mock("../../src/audit/dispatcher", () => ({
  dispatchAuditRecord: vi.fn(async () => undefined),
}))

const databaseUrl = requireRealDatabaseUrl()

const { visitCheckout } = await import("../../src/invoice/checkout-provider")
const { invoiceService } = await import("../../src/invoice/service")

let nextId = 9_207_000_000_000_000n
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

/** An OPEN stripeCheckout invoice (as finalize leaves it) with two lines. */
async function seedOpenCheckoutInvoice(token: string) {
  const workspaceId = mintId()
  const contactId = mintId()
  const integrationId = mintId()
  const invoiceId = mintId()
  await asReplica(sql`
    INSERT INTO "Workspace" (id, name, "ownerId")
    VALUES (${workspaceId}, ${`s207b checkout ${workspaceId}`}, 1)`)
  seeded.Workspace?.push(workspaceId)
  await asReplica(sql`
    INSERT INTO "Contact" (id, "workspaceId") VALUES (${contactId}, ${workspaceId})`)
  seeded.Contact?.push(contactId)
  await asReplica(sql`
    INSERT INTO "Integration" (id, "workspaceId", "integrationType")
    VALUES (${integrationId}, ${workspaceId}, 'stripe')`)
  seeded.Integration?.push(integrationId)
  m.integrations.set(workspaceId, integrationId)
  await asReplica(sql`
    INSERT INTO "Invoice" (id, "workspaceId", number, status, method, currency,
      total, "contactId", "integrationId", "providerAccountId",
      "providerCustomerId", "payToken", "hostedUrl")
    VALUES (${invoiceId}, ${workspaceId}, 1, 'open', 'stripeCheckout', 'USD',
      '12.50', ${contactId}, ${integrationId}, 'acct_rdb', 'cus_rdb', ${token},
      ${`https://chat.example.org/pay/${token}`})`)
  await asReplica(sql`
    INSERT INTO "InvoiceLineItem" (id, "invoiceId", position, description,
      quantity, "unitAmount", amount)
    VALUES (${mintId()}, ${invoiceId}, 0, 'Consult', 2, '5.00', '10.00'),
           (${mintId()}, ${invoiceId}, 1, 'Report', 1, '2.50', '2.50')`)
  return { workspaceId, invoiceId }
}

async function invoiceRow(invoiceId: string) {
  const result = await db.execute<{
    status: string
    checkoutGeneration: number
    checkoutSessionId: string | null
  }>(sql`
    SELECT status, "checkoutGeneration", "checkoutSessionId"
      FROM "Invoice" WHERE id = ${invoiceId}`)
  return result.rows[0]
}

const openSessions = () =>
  [...m.stripe.sessions.values()].filter((s) => s.status === "open")

beforeEach(() => {
  m.stripe.sessions.clear()
  m.stripe.keys.clear()
  m.stripe.creates = 0
  m.stripe.counter = 0
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

describe.skipIf(!databaseUrl)("/pay visits under concurrency (s207b)", () => {
  test("8 concurrent first visits: one Stripe session, generation 1, every link the same", async () => {
    const { invoiceId } = await seedOpenCheckoutInvoice(TOKEN_A)
    const visits = await Promise.all(
      Array.from({ length: 8 }, () => visitCheckout(TOKEN_A)),
    )
    const urls = new Set(
      visits.map((v) => (v.kind === "redirect" ? v.url : v.kind)),
    )
    expect(urls.size).toBe(1)
    expect([...urls][0]).toContain("cs_rdb_1")
    expect(m.stripe.creates).toBe(1)
    expect(await invoiceRow(invoiceId)).toMatchObject({
      checkoutGeneration: 1,
      checkoutSessionId: "cs_rdb_1",
    })
  })

  test("8 concurrent visits on an expiring session leave exactly one open session, the one recorded", async () => {
    const { invoiceId } = await seedOpenCheckoutInvoice(TOKEN_A)
    await visitCheckout(TOKEN_A)
    const first = m.stripe.sessions.get("cs_rdb_1")
    if (first) {
      first.expires_at = Math.floor((Date.now() + 60_000) / 1000)
    }
    await Promise.all(Array.from({ length: 8 }, () => visitCheckout(TOKEN_A)))
    const row = await invoiceRow(invoiceId)
    expect(openSessions().map((s) => s.id)).toEqual([row?.checkoutSessionId])
    expect(row?.checkoutGeneration).toBe(2)
  })

  test("a void racing 6 visits leaves the invoice void and NO session open", async () => {
    const { workspaceId, invoiceId } = await seedOpenCheckoutInvoice(TOKEN_A)
    await Promise.all([
      ...Array.from({ length: 6 }, () =>
        visitCheckout(TOKEN_A).catch(() => undefined),
      ),
      invoiceService.void({ workspaceId, id: invoiceId }),
    ])
    // Visits that started after the void answer closed; none reopens it.
    expect((await visitCheckout(TOKEN_A)).kind).toBe("closed")
    expect((await invoiceRow(invoiceId))?.status).toBe("void")
    expect(openSessions()).toEqual([])
  })
})
