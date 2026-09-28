// @vitest-environment node

/**
 * QuickBooks Online (s214b) against a REAL Postgres and an in-memory QBO
 * company (MSW, `../helpers/fake-quickbooks`). Pinned:
 * - the `quickbooks` method opens a QBO invoice with a pay link, refuses a
 *   contact without an email, voids its own copy when QBO gives no link or a
 *   different total, and adopts a copy a lost answer left behind;
 * - a QBO payment settles the hub invoice ONCE under 8 concurrent jobs, a
 *   payment after a hub void is flagged (never applied), and a void is
 *   refused while QBO shows a payment;
 * - tokens: an expired access token is refreshed once for 6 concurrent
 *   callers and the ROTATED refresh token is what is stored; invalid_grant
 *   marks the company for a reconnect and new invoices are refused;
 * - the mirror copies a Stripe Checkout invoice (invoice, then a payment
 *   into Undeposited Funds) exactly once under concurrent syncs, and the
 *   sweep and the CDC poll find what the webhooks missed.
 * The lock is an in-process keyed mutex; the queue, marks and events are
 * recorded mocks.
 *
 *     DATABASE_URL=postgres://... pnpm --filter @chatbotx.io/business test:db
 */

import { createHmac } from "node:crypto"
import { db, sql } from "@chatbotx.io/database/client"
import { server } from "@chatbotx.io/vitest-config/msw"
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
import { fakeQuickbooks } from "../helpers/fake-quickbooks"

const APP = {
  clientId: "qbo-client",
  clientSecret: "qbo-secret",
  webhookVerifierToken: "qbo-verifier",
  environment: "sandbox" as const,
}

const m = vi.hoisted(() => {
  const chains = new Map<string, Promise<unknown>>()
  return {
    marks: vi.fn(async () => undefined),
    emitPaid: vi.fn(async () => undefined),
    enqueue: vi.fn(async () => undefined),
    lock: async <T>(props: { key: string; fn: () => Promise<T> }) => {
      const previous = chains.get(props.key) ?? Promise.resolve()
      const run = previous.then(props.fn, props.fn)
      chains.set(
        props.key,
        run.catch(() => undefined),
      )
      return await run
    },
  }
})

vi.mock("@chatbotx.io/redis", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chatbotx.io/redis")>()),
  distributedLock: { runExclusive: m.lock },
}))
vi.mock("@chatbotx.io/worker-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chatbotx.io/worker-config")>()),
  defaultQueue: { add: m.enqueue },
}))
vi.mock("../../src/platform-credential/service", () => ({
  platformCredentialService: {
    findDecryptedPlatform: async () => ({ config: APP }),
  },
}))
vi.mock("../../src/platform/settings", () => ({
  resolveWorkspaceAppUrl: async () => "https://chat.example.org",
}))
vi.mock("../../src/invoice/contact-marks", () => ({
  markInvoiceOnContact: m.marks,
  markInvoiceCreated: vi.fn(async () => undefined),
}))
vi.mock("../../src/invoice/document", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/invoice/document")>()),
  prerenderInvoiceReceipt: vi.fn(async () => undefined),
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

const { invoiceService } = await import("../../src/invoice/service")
const {
  handleQuickbooksWebhook,
  pollQuickbooksChanges,
  processQuickbooksChange,
} = await import("../../src/invoice/quickbooks-webhook")
const { invoiceBookkeepingStates, syncInvoiceMirror, sweepInvoiceMirrors } =
  await import("../../src/invoice/mirror")
const { encryptQuickbooksAuth, withQuickbooksToken } = await import(
  "../../src/integration-quickbooks/connection"
)
const { QuickbooksReconnectRequiredError } = await import(
  "../../src/integration-quickbooks/client"
)
const { InvoiceFinalizeError } = await import("../../src/invoice/providers")

const PROVIDER_ID_RE = /^qbo:\d+:\d+$/
const INVOICE_LINK_RE = /^https:\/\/connect\.intuit\.com\//
const PDF_URL_RE = /^https:\/\/chat\.example\.org\/pay\/.+\/pdf$/
const EMAIL_RE = /email/
const REFUND_RE = /already has a payment: refund it in QuickBooks/
const UNPAID_AGAIN_RE = /unpaid again/
const STILL_COLLECTED_RE = /still collected through this QuickBooks company/
const PAYMENTS_RE = /QuickBooks Payments/
const VOIDED_RE = /^Voided/
const TAX_RE = /totals this invoice at 17\.23 USD, not 16\.00/
const CONTACT_WRITE_RE = /contact write/
const HAS_PAYMENT_RE = /already has a payment/
const RECONNECT_RE = /reconnect/i
const NEEDS_RECONNECT_RE = /needs to be reconnected/

let nextId = 9_214_000_000_000_000n
function mintId(): string {
  nextId += 1n
  return nextId.toString()
}

const seededWorkspaces: string[] = []

async function asReplica(statement: ReturnType<typeof sql>): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`)
    await tx.execute(statement)
  })
}

type Fake = ReturnType<typeof fakeQuickbooks>
let fake: Fake

async function seedCompany(
  props: {
    email?: string | null
    mirror?: boolean
    accessExpiresAt?: number
    /** Another company than the fake's (one that is never called). */
    realmId?: string
  } = {},
) {
  const workspaceId = mintId()
  const contactId = mintId()
  const integrationId = mintId()
  seededWorkspaces.push(workspaceId)
  await asReplica(sql`
    INSERT INTO "Workspace" (id, name, "ownerId")
    VALUES (${workspaceId}, ${`s214b quickbooks ${workspaceId}`}, 1)`)
  const email = props.email === undefined ? "pat@example.org" : props.email
  await asReplica(sql`
    INSERT INTO "Contact" (id, "workspaceId", "firstName", "lastName", email, "phoneNumber")
    VALUES (${contactId}, ${workspaceId}, 'Pat', 'Baker', ${email}, '+15550001234')`)
  await asReplica(sql`
    INSERT INTO "Integration" (id, "workspaceId", "integrationType")
    VALUES (${integrationId}, ${workspaceId}, 'quickbooks')`)
  const auth = await encryptQuickbooksAuth(
    {
      accessToken: fake.state.accessToken,
      accessExpiresAt: props.accessExpiresAt ?? Date.now() + 3_600_000,
      refreshToken: fake.state.refreshToken,
      refreshExpiresAt: Date.now() + 86_400_000,
    },
    integrationId,
  )
  await asReplica(sql`
    INSERT INTO "IntegrationQuickbooks" (id, "workspaceId", "integrationId",
      "realmId", environment, "companyName", "homeCurrency", auth,
      "tokenRefreshedAt", "itemId", "mirrorEnabled", "mirrorFrom", "changesSince")
    VALUES (${mintId()}, ${workspaceId}, ${integrationId}, ${props.realmId ?? fake.state.realmId},
      'sandbox', 'Fake Bakery LLC', 'USD', ${JSON.stringify(auth)}::jsonb, now(), '1',
      ${props.mirror ?? false}, ${props.mirror ? sql`now() - interval '1 hour'` : null},
      now() - interval '1 hour')`)
  return { workspaceId, contactId, integrationId }
}

const createQuickbooksInvoice = (company: {
  workspaceId: string
  contactId: string
}) =>
  invoiceService.create({
    workspaceId: company.workspaceId,
    contactId: company.contactId,
    currency: "USD",
    lines: [
      { description: "Sourdough", quantity: 2, unitAmount: "6.50" },
      { description: "Delivery", quantity: 1, unitAmount: "3.00" },
    ],
    dueDays: 7,
    method: "quickbooks",
  })

async function invoiceRow(invoiceId: string) {
  const result = await db.execute<{
    status: string
    providerInvoiceId: string | null
    lastError: string | null
  }>(
    sql`SELECT status, "providerInvoiceId", "lastError" FROM "Invoice" WHERE id = ${invoiceId}`,
  )
  return result.rows[0]
}

const qboIdOf = (providerInvoiceId: string | null) =>
  providerInvoiceId?.split(":")[2] ?? ""

beforeEach(() => {
  fake = fakeQuickbooks({ realmId: `9130${Math.floor(Math.random() * 1e12)}` })
  server.use(...fake.handlers)
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
    for (const table of [
      "InvoiceEvent",
      "InvoiceMirror",
      "QuickbooksCustomer",
      "IntegrationQuickbooks",
    ]) {
      await asReplica(
        sql`DELETE FROM ${sql.identifier(table)} WHERE "workspaceId" IN (${list})`,
      )
    }
    await asReplica(sql`
      DELETE FROM "InvoiceLineItem" WHERE "invoiceId" IN
        (SELECT id FROM "Invoice" WHERE "workspaceId" IN (${list}))`)
    for (const table of ["Invoice", "Contact", "Integration"]) {
      await asReplica(
        sql`DELETE FROM ${sql.identifier(table)} WHERE "workspaceId" IN (${list})`,
      )
    }
    await asReplica(sql`DELETE FROM "Workspace" WHERE id IN (${list})`)
  }
  m.marks.mockClear()
  m.emitPaid.mockClear()
  m.enqueue.mockClear()
})

afterAll(async () => {
  if (!databaseUrl) {
    return
  }
  await db.$client.end()
})

describe.skipIf(!databaseUrl)("quickbooks method (s214b)", () => {
  test("opens a QBO invoice whose InvoiceLink is the pay link", async () => {
    const company = await seedCompany()
    const invoice = await createQuickbooksInvoice(company)
    expect(invoice.status).toBe("open")
    expect(invoice.providerInvoiceId).toMatch(PROVIDER_ID_RE)
    expect(invoice.providerAccountId).toBe(fake.state.realmId)
    expect(invoice.hostedUrl).toMatch(INVOICE_LINK_RE)
    expect(invoice.pdfUrl).toMatch(PDF_URL_RE)
    const created = fake.apiCalls("POST", "invoice")
    expect(created).toHaveLength(1)
    expect(created[0]?.requestId).toMatch(new RegExp(`^hub-inv-${invoice.id}-`))
    const body = created[0]?.body as Record<string, unknown>
    expect(body.PrivateNote).toContain(`[hub:${invoice.id}]`)
    expect(body.BillEmail).toEqual({ Address: "pat@example.org" })
    expect(body.DocNumber).toBeUndefined()
    expect(fake.state.customers.size).toBe(1)
  })

  test("a contact without an email is refused before any QBO invoice", async () => {
    const company = await seedCompany({ email: null })
    const error = await createQuickbooksInvoice(company).catch((e) => e)
    expect(error).toBeInstanceOf(InvoiceFinalizeError)
    expect(error.retryable).toBe(false)
    expect(error.message).toMatch(EMAIL_RE)
    expect(fake.apiCalls("POST", "invoice")).toHaveLength(0)
    const [draft] = (
      await db.execute<{ status: string; lastError: string }>(sql`
        SELECT status, "lastError" FROM "Invoice" WHERE "workspaceId" = ${company.workspaceId}`)
    ).rows
    expect(draft?.status).toBe("draft")
    expect(draft?.lastError).toMatch(EMAIL_RE)
  })

  test("no pay link (QuickBooks Payments off): its QBO copy is voided, the draft refused", async () => {
    const company = await seedCompany()
    fake.state.paymentsEnabled = false
    const error = await createQuickbooksInvoice(company).catch((e) => e)
    expect(error).toBeInstanceOf(InvoiceFinalizeError)
    expect(error.message).toMatch(PAYMENTS_RE)
    const [qbo] = [...fake.state.invoices.values()]
    expect(String(qbo?.PrivateNote)).toMatch(VOIDED_RE)
  })

  test("a QBO total that differs (sales tax) is voided there and refused", async () => {
    const company = await seedCompany()
    fake.state.taxOnCreate = 1.23
    const error = await createQuickbooksInvoice(company).catch((e) => e)
    expect(error.message).toMatch(TAX_RE)
    expect(String([...fake.state.invoices.values()][0]?.PrivateNote)).toMatch(
      VOIDED_RE,
    )
  })

  test("a retry after a lost answer adopts the QBO copy instead of creating another", async () => {
    const company = await seedCompany()
    // First attempt: QBO creates the invoice, but the answer is lost (500).
    fake.state.failNext.set("POST invoice", [500, {}])
    const first = await createQuickbooksInvoice(company).catch((e) => e)
    expect(first).toBeInstanceOf(InvoiceFinalizeError)
    expect(first.retryable).toBe(true)
    // The fake refused before creating: create one "behind the hub's back"
    // with the marker, as a lost answer would leave it.
    const [draft] = (
      await db.execute<{ id: string }>(sql`
        SELECT id FROM "Invoice" WHERE "workspaceId" = ${company.workspaceId}`)
    ).rows
    const customerId = [...fake.state.customers.keys()][0] as string
    fake.state.invoices.set("777", {
      Id: "777",
      SyncToken: "0",
      TotalAmt: 16,
      Balance: 16,
      CustomerRef: { value: customerId },
      PrivateNote: `Hub invoice #1 [hub:${draft?.id}]`,
      BillEmail: { Address: "pat@example.org" },
      AllowOnlineCreditCardPayment: true,
      MetaData: {
        CreateTime: new Date().toISOString(),
        LastUpdatedTime: new Date().toISOString(),
      },
    })
    const opened = await invoiceService.finalize({
      workspaceId: company.workspaceId,
      id: draft?.id as string,
    })
    expect(opened.status).toBe("open")
    expect(opened.providerInvoiceId).toBe(`qbo:${fake.state.realmId}:777`)
    expect(fake.apiCalls("POST", "invoice")).toHaveLength(1)
  })

  test("a QBO payment settles the hub invoice once under 8 concurrent jobs", async () => {
    const company = await seedCompany()
    const invoice = await createQuickbooksInvoice(company)
    const qboId = qboIdOf(invoice.providerInvoiceId)
    const payment = fake.pay(qboId)
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        processQuickbooksChange({
          workspaceId: company.workspaceId,
          integrationId: company.integrationId,
          entity: i % 2 ? "Payment" : "Invoice",
          entityId: i % 2 ? (payment.Id as string) : qboId,
        }),
      ),
    )
    expect(results.flat().filter((o) => o === "paid")).toHaveLength(1)
    expect((await invoiceRow(invoice.id))?.status).toBe("paid")
    expect(m.marks).toHaveBeenCalledTimes(1)
    expect(m.emitPaid).toHaveBeenCalledTimes(1)
    const events = await db.execute<{ outcome: string }>(sql`
      SELECT outcome FROM "InvoiceEvent" WHERE "invoiceId" = ${invoice.id}`)
    expect(events.rows).toEqual([{ outcome: "marked:paid" }])
  })

  test("marks that failed run again on the next reading, and only then", async () => {
    const company = await seedCompany()
    const invoice = await createQuickbooksInvoice(company)
    const qboId = qboIdOf(invoice.providerInvoiceId)
    fake.pay(qboId)
    m.marks.mockRejectedValueOnce(new Error("contact write failed"))
    const job = {
      workspaceId: company.workspaceId,
      integrationId: company.integrationId,
      entity: "Invoice" as const,
      entityId: qboId,
    }
    await expect(processQuickbooksChange(job)).rejects.toThrow(CONTACT_WRITE_RE)
    expect((await invoiceRow(invoice.id))?.status).toBe("paid")
    await processQuickbooksChange(job)
    await processQuickbooksChange(job)
    expect(m.marks).toHaveBeenCalledTimes(2)
  })

  test("a void is refused while QBO shows a payment", async () => {
    const company = await seedCompany()
    const invoice = await createQuickbooksInvoice(company)
    fake.pay(qboIdOf(invoice.providerInvoiceId))
    await expect(
      invoiceService.void({ workspaceId: company.workspaceId, id: invoice.id }),
    ).rejects.toThrow(HAS_PAYMENT_RE)
    expect((await invoiceRow(invoice.id))?.status).toBe("open")
  })

  test("a hub void voids at QBO; a failed QBO void is named; a later payment is flagged", async () => {
    const company = await seedCompany()
    const invoice = await createQuickbooksInvoice(company)
    const qboId = qboIdOf(invoice.providerInvoiceId)
    // The QBO void answers a server error: the hub void stands, lastError names it.
    fake.state.failNext.set("POST invoice", [500, {}])
    const voided = await invoiceService.void({
      workspaceId: company.workspaceId,
      id: invoice.id,
    })
    expect(voided.status).toBe("void")
    expect(voided.lastError).toMatch(
      new RegExp(`QuickBooks invoice ${qboId} was not voided`),
    )
    // The customer pays the still-open QBO invoice.
    fake.pay(qboId)
    const outcomes = await processQuickbooksChange({
      workspaceId: company.workspaceId,
      integrationId: company.integrationId,
      entity: "Invoice",
      entityId: qboId,
    })
    expect(outcomes).toEqual(["paid-after-void"])
    const row = await invoiceRow(invoice.id)
    expect(row?.status).toBe("void")
    expect(m.marks).not.toHaveBeenCalled()
  })

  test("a clean hub void voids the QBO invoice with its current SyncToken", async () => {
    const company = await seedCompany()
    const invoice = await createQuickbooksInvoice(company)
    const qboId = qboIdOf(invoice.providerInvoiceId)
    // Someone edited it in QBO: the SyncToken moved on.
    const qbo = fake.state.invoices.get(qboId) as Record<string, unknown>
    qbo.SyncToken = "4"
    await invoiceService.void({
      workspaceId: company.workspaceId,
      id: invoice.id,
    })
    expect(String(fake.state.invoices.get(qboId)?.PrivateNote)).toMatch(
      VOIDED_RE,
    )
    expect((await invoiceRow(invoice.id))?.lastError).toBeNull()
  })

  test("a payment landing after the pre-void read is never voided away", async () => {
    const company = await seedCompany()
    const invoice = await createQuickbooksInvoice(company)
    const qboId = qboIdOf(invoice.providerInvoiceId)
    // prepareVoid's read fails (unreachable voids, owner rule); the customer
    // pays before afterVoid re-reads it.
    fake.state.failNext.set("GET invoice/", [500, {}])
    fake.pay(qboId)
    const voided = await invoiceService.void({
      workspaceId: company.workspaceId,
      id: invoice.id,
    })
    expect(voided.status).toBe("void")
    expect(voided.lastError).toMatch(REFUND_RE)
    expect(fake.state.invoices.get(qboId)?.PrivateNote).not.toMatch(VOIDED_RE)
    expect(fake.apiCalls("POST", "invoice").length).toBe(1)
  })

  test("voiding a draft voids the QBO copy a lost answer left unrecorded", async () => {
    const company = await seedCompany()
    fake.state.dropAnswer.add("POST invoice")
    const error = await createQuickbooksInvoice(company).catch((e) => e)
    expect(error).toBeInstanceOf(InvoiceFinalizeError)
    const [draft] = (
      await db.execute<{ id: string }>(sql`
        SELECT id FROM "Invoice" WHERE "workspaceId" = ${company.workspaceId}`)
    ).rows
    expect(fake.state.invoices.size).toBe(1)
    await invoiceService.void({
      workspaceId: company.workspaceId,
      id: draft?.id as string,
    })
    const [copy] = [...fake.state.invoices.values()]
    expect(String(copy?.PrivateNote)).toMatch(VOIDED_RE)
  })

  test("a voided copy never shadows the live one on adoption", async () => {
    const company = await seedCompany()
    fake.state.dropAnswer.add("POST invoice")
    await createQuickbooksInvoice(company).catch(() => undefined)
    const [draft] = (
      await db.execute<{ id: string }>(sql`
        SELECT id FROM "Invoice" WHERE "workspaceId" = ${company.workspaceId}`)
    ).rows
    const live = [...fake.state.invoices.values()][0] as Record<string, unknown>
    // An older voided copy of the same hub invoice sits first in QBO.
    const voidedCopy = {
      ...live,
      Id: "5",
      TotalAmt: 0,
      Balance: 0,
      PrivateNote: `Voided - ${live.PrivateNote}`,
    }
    fake.state.invoices = new Map([
      ["5", voidedCopy],
      [live.Id as string, live],
    ])
    const opened = await invoiceService.finalize({
      workspaceId: company.workspaceId,
      id: draft?.id as string,
    })
    expect(opened.providerInvoiceId).toBe(
      `qbo:${fake.state.realmId}:${live.Id}`,
    )
    expect(fake.apiCalls("POST", "invoice")).toHaveLength(1)
  })

  test("paid at open queues a settle read so the paid marks still run", async () => {
    const company = await seedCompany()
    fake.state.dropAnswer.add("POST invoice")
    await createQuickbooksInvoice(company).catch(() => undefined)
    const [draft] = (
      await db.execute<{ id: string }>(sql`
        SELECT id FROM "Invoice" WHERE "workspaceId" = ${company.workspaceId}`)
    ).rows
    const qboId = [...fake.state.invoices.keys()][0] as string
    fake.pay(qboId)
    m.enqueue.mockClear()
    const opened = await invoiceService.finalize({
      workspaceId: company.workspaceId,
      id: draft?.id as string,
    })
    expect(opened.status).toBe("paid")
    expect(m.enqueue).toHaveBeenCalledWith(
      "quickbooksEntityChanged",
      expect.objectContaining({
        data: expect.objectContaining({ entity: "Invoice", entityId: qboId }),
      }),
      expect.objectContaining({
        jobId: expect.stringContaining("qbo-change-open-"),
      }),
    )
    const outcomes = await processQuickbooksChange({
      workspaceId: company.workspaceId,
      integrationId: company.integrationId,
      entity: "Invoice",
      entityId: qboId,
    })
    expect(outcomes).toEqual(["paid"])
    expect(m.marks).toHaveBeenCalledTimes(1)
  })

  test("a payment reversed in QBO flags the paid hub invoice, never un-pays it", async () => {
    const company = await seedCompany()
    const invoice = await createQuickbooksInvoice(company)
    const qboId = qboIdOf(invoice.providerInvoiceId)
    fake.pay(qboId)
    const job = {
      workspaceId: company.workspaceId,
      integrationId: company.integrationId,
      entity: "Invoice" as const,
      entityId: qboId,
    }
    await processQuickbooksChange(job)
    const qbo = fake.state.invoices.get(qboId) as Record<string, unknown>
    qbo.Balance = qbo.TotalAmt
    await expect(processQuickbooksChange(job)).resolves.toEqual([
      "unpaid-after-paid",
    ])
    const row = await invoiceRow(invoice.id)
    expect(row?.status).toBe("paid")
    expect(row?.lastError).toMatch(UNPAID_AGAIN_RE)
  })

  test("disconnect is refused while a quickbooks invoice is live", async () => {
    const company = await seedCompany()
    await createQuickbooksInvoice(company)
    const { integrationQuickbooksService } = await import(
      "../../src/integration-quickbooks/service"
    )
    await expect(
      integrationQuickbooksService.disconnect(company.workspaceId),
    ).rejects.toThrow(STILL_COLLECTED_RE)
  })

  test("the signed webhook queues known companies' changes only", async () => {
    const company = await seedCompany()
    const body = Buffer.from(
      JSON.stringify([
        {
          specversion: "1.0",
          id: "e1",
          type: "qbo.payment.created.v1",
          intuitentityid: "55",
          intuitaccountid: fake.state.realmId,
        },
        {
          specversion: "1.0",
          id: "e2",
          type: "qbo.invoice.updated.v1",
          intuitentityid: "56",
          intuitaccountid: "4242",
        },
      ]),
    )
    const signature = createHmac("sha256", APP.webhookVerifierToken)
      .update(body)
      .digest("base64")
    await expect(
      handleQuickbooksWebhook({ rawBody: body, signature: "bad" }),
    ).resolves.toEqual({ status: 401, queued: 0 })
    await expect(
      handleQuickbooksWebhook({ rawBody: body, signature }),
    ).resolves.toEqual({ status: 200, queued: 1 })
    expect(m.enqueue).toHaveBeenCalledWith(
      "quickbooksEntityChanged",
      {
        type: "quickbooksEntityChanged",
        data: {
          workspaceId: company.workspaceId,
          integrationId: company.integrationId,
          entity: "Payment",
          entityId: "55",
        },
      },
      expect.objectContaining({
        jobId: expect.stringContaining("qbo-change-"),
      }),
    )
  })

  test("the CDC poll queues a payment the webhook never delivered", async () => {
    const company = await seedCompany()
    const invoice = await createQuickbooksInvoice(company)
    const payment = fake.pay(qboIdOf(invoice.providerInvoiceId))
    m.enqueue.mockClear()
    const result = await pollQuickbooksChanges()
    expect(result.failed).toBe(0)
    const queued = m.enqueue.mock.calls.map(
      (call) =>
        (
          call as unknown as [
            string,
            { data: { entity: string; entityId: string } },
          ]
        )[1].data,
    )
    expect(queued).toContainEqual(
      expect.objectContaining({ entity: "Payment", entityId: payment.Id }),
    )
    const [row] = (
      await db.execute<{ changesSince: Date }>(sql`
        SELECT "changesSince" FROM "IntegrationQuickbooks"
         WHERE "integrationId" = ${company.integrationId}`)
    ).rows
    expect(new Date(row?.changesSince as Date).getTime()).toBeGreaterThan(
      Date.now() - 60_000,
    )
  })
})

describe.skipIf(!databaseUrl)("quickbooks tokens (s214b)", () => {
  test("6 concurrent callers with an expired token refresh ONCE; the rotated token is stored", async () => {
    const company = await seedCompany({ accessExpiresAt: Date.now() - 1000 })
    const firstRefresh = fake.state.refreshToken
    const tokens = await Promise.all(
      Array.from({ length: 6 }, () =>
        withQuickbooksToken(
          company.integrationId,
          async ({ accessToken }) => accessToken,
        ),
      ),
    )
    expect(fake.state.refreshes).toBe(1)
    expect(new Set(tokens).size).toBe(1)
    expect(tokens[0]).toBe(fake.state.accessToken)
    const [row] = (
      await db.execute<{ tokenVersion: number }>(sql`
        SELECT "tokenVersion" FROM "IntegrationQuickbooks"
         WHERE "integrationId" = ${company.integrationId}`)
    ).rows
    expect(row?.tokenVersion).toBe(1)
    expect(fake.state.refreshToken).not.toBe(firstRefresh)
    // The stored pair is the rotated one: a second forced refresh works.
    fake.state.accessToken = "revoked-by-intuit"
    await withQuickbooksToken(
      company.integrationId,
      ({ accessToken, connection }) =>
        fetch(fake.api(`companyinfo/${connection.realmId}`), {
          headers: { authorization: `Bearer ${accessToken}` },
        }).then(async (r) => {
          if (r.status === 401) {
            const { QuickbooksApiError } = await import(
              "../../src/integration-quickbooks/client"
            )
            throw new QuickbooksApiError("401", {
              status: 401,
              retryable: false,
              authRejected: true,
            })
          }
          return r.status
        }),
    )
    expect(fake.state.refreshes).toBe(2)
  })

  test("invalid_grant marks the company for a reconnect; new invoices are refused", async () => {
    const company = await seedCompany({ accessExpiresAt: Date.now() - 1000 })
    fake.state.refreshToken = "rotated-elsewhere"
    await expect(
      withQuickbooksToken(company.integrationId, async () => "never"),
    ).rejects.toBeInstanceOf(QuickbooksReconnectRequiredError)
    const [row] = (
      await db.execute<{ tokenRefreshError: string | null }>(sql`
        SELECT "tokenRefreshError" FROM "IntegrationQuickbooks"
         WHERE "integrationId" = ${company.integrationId}`)
    ).rows
    expect(row?.tokenRefreshError).toMatch(RECONNECT_RE)
    await expect(createQuickbooksInvoice(company)).rejects.toThrow(
      NEEDS_RECONNECT_RE,
    )
    expect(fake.state.refreshes).toBe(0)
  })
})

async function seedCheckoutInvoice(props: {
  workspaceId: string
  contactId: string
  status: string
  number: number
}) {
  const invoiceId = mintId()
  await asReplica(sql`
    INSERT INTO "Invoice" (id, "workspaceId", number, status, method, currency,
      total, "contactId", "paidAt")
    VALUES (${invoiceId}, ${props.workspaceId}, ${props.number}, ${props.status},
      'stripeCheckout', 'USD', '42.50', ${props.contactId},
      ${props.status === "paid" ? sql`now()` : null})`)
  await asReplica(sql`
    INSERT INTO "InvoiceLineItem" (id, "invoiceId", position, description,
      quantity, "unitAmount", amount)
    VALUES (${mintId()}, ${invoiceId}, 0, 'Catering', 1, '42.50', '42.50')`)
  return invoiceId
}

describe.skipIf(!databaseUrl)("quickbooks mirror (s214b)", () => {
  test("an open then paid Stripe invoice: one QBO invoice, one payment, under concurrency", async () => {
    const company = await seedCompany({ mirror: true })
    const invoiceId = await seedCheckoutInvoice({
      ...company,
      status: "open",
      number: 1,
    })
    const outcomes = await Promise.all(
      Array.from({ length: 4 }, () =>
        syncInvoiceMirror({ workspaceId: company.workspaceId, invoiceId }),
      ),
    )
    expect(outcomes.filter((o) => o === "synced")).toHaveLength(1)
    expect(fake.state.invoices.size).toBe(1)
    const copy = [...fake.state.invoices.values()][0] as Record<string, unknown>
    expect(copy.AllowOnlineCreditCardPayment).toBe(false)
    expect(copy.BillEmail).toBeUndefined()

    await asReplica(
      sql`UPDATE "Invoice" SET status = 'paid', "paidAt" = now() WHERE id = ${invoiceId}`,
    )
    await Promise.all(
      Array.from({ length: 4 }, () =>
        syncInvoiceMirror({ workspaceId: company.workspaceId, invoiceId }),
      ),
    )
    expect(fake.state.payments.size).toBe(1)
    const payment = [...fake.state.payments.values()][0] as Record<
      string,
      unknown
    >
    expect(payment.DepositToAccountRef).toBeUndefined()
    expect(payment.TotalAmt).toBe(42.5)
    expect(copy.Balance).toBe(0)
    const [mirror] = (
      await db.execute<{ syncedStatus: string; lastError: string | null }>(sql`
        SELECT "syncedStatus", "lastError" FROM "InvoiceMirror" WHERE "invoiceId" = ${invoiceId}`)
    ).rows
    expect(mirror).toEqual({ syncedStatus: "paid", lastError: null })
  })

  test("paid at first sight (the open job was lost): invoice and payment in one sync", async () => {
    const company = await seedCompany({ mirror: true })
    const invoiceId = await seedCheckoutInvoice({
      ...company,
      status: "paid",
      number: 1,
    })
    await syncInvoiceMirror({ workspaceId: company.workspaceId, invoiceId })
    expect(fake.state.invoices.size).toBe(1)
    expect(fake.state.payments.size).toBe(1)
  })

  test("a void before any copy writes nothing; a void after one voids it", async () => {
    const company = await seedCompany({ mirror: true })
    const neverCopied = await seedCheckoutInvoice({
      ...company,
      status: "void",
      number: 1,
    })
    await expect(
      syncInvoiceMirror({
        workspaceId: company.workspaceId,
        invoiceId: neverCopied,
      }),
    ).resolves.toBe("synced")
    expect(fake.state.invoices.size).toBe(0)

    const copied = await seedCheckoutInvoice({
      ...company,
      status: "open",
      number: 2,
    })
    await syncInvoiceMirror({
      workspaceId: company.workspaceId,
      invoiceId: copied,
    })
    await asReplica(
      sql`UPDATE "Invoice" SET status = 'void' WHERE id = ${copied}`,
    )
    await syncInvoiceMirror({
      workspaceId: company.workspaceId,
      invoiceId: copied,
    })
    expect(String([...fake.state.invoices.values()][0]?.PrivateNote)).toMatch(
      VOIDED_RE,
    )
  })

  test("skips: mirror off, a quickbooks-method invoice, an invoice before mirrorFrom", async () => {
    const off = await seedCompany({ mirror: false, realmId: mintId() })
    const offInvoice = await seedCheckoutInvoice({
      ...off,
      status: "open",
      number: 1,
    })
    await expect(
      syncInvoiceMirror({
        workspaceId: off.workspaceId,
        invoiceId: offInvoice,
      }),
    ).resolves.toBe("skipped")

    const on = await seedCompany({ mirror: true })
    const old = await seedCheckoutInvoice({ ...on, status: "open", number: 1 })
    await asReplica(
      sql`UPDATE "Invoice" SET "createdAt" = now() - interval '2 days' WHERE id = ${old}`,
    )
    await expect(
      syncInvoiceMirror({ workspaceId: on.workspaceId, invoiceId: old }),
    ).resolves.toBe("skipped")
    const own = await createQuickbooksInvoice(on)
    await expect(
      syncInvoiceMirror({ workspaceId: on.workspaceId, invoiceId: own.id }),
    ).resolves.toBe("skipped")
    expect(fake.state.invoices.size).toBe(1)
  })

  test("a QBO refusal is permanent (no retry storm); a 5xx is retried and counted", async () => {
    const company = await seedCompany({ mirror: true })
    const invoiceId = await seedCheckoutInvoice({
      ...company,
      status: "open",
      number: 1,
    })
    fake.state.failNext.set("POST invoice", [
      400,
      { Fault: { Error: [{ Message: "Invalid Reference Id", code: "2500" }] } },
    ])
    await expect(
      syncInvoiceMirror({ workspaceId: company.workspaceId, invoiceId }),
    ).resolves.toBe("failed-permanent")
    const second = await seedCheckoutInvoice({
      ...company,
      status: "open",
      number: 2,
    })
    fake.state.failNext.set("POST invoice", [503, {}])
    await expect(
      syncInvoiceMirror({
        workspaceId: company.workspaceId,
        invoiceId: second,
      }),
    ).rejects.toThrow()
    const rows = (
      await db.execute<{ invoiceId: string; attempts: number }>(sql`
        SELECT "invoiceId", attempts FROM "InvoiceMirror" WHERE "workspaceId" = ${company.workspaceId}`)
    ).rows
    expect(rows.find((r) => r.invoiceId === invoiceId)?.attempts).toBe(5)
    expect(rows.find((r) => r.invoiceId === second)?.attempts).toBe(1)
    // The sweep re-queues the retryable one only.
    m.enqueue.mockClear()
    await sweepInvoiceMirrors()
    const swept = m.enqueue.mock.calls.map(
      (call) =>
        (call as unknown as [string, { data: { invoiceId: string } }])[1].data
          .invoiceId,
    )
    expect(swept).toContain(second)
    expect(swept).not.toContain(invoiceId)
  })

  test("list states: synced, pending, error; uncovered invoices have none", async () => {
    const company = await seedCompany({ mirror: true })
    const synced = await seedCheckoutInvoice({
      ...company,
      status: "open",
      number: 1,
    })
    const pending = await seedCheckoutInvoice({
      ...company,
      status: "paid",
      number: 2,
    })
    const failing = await seedCheckoutInvoice({
      ...company,
      status: "open",
      number: 3,
    })
    await syncInvoiceMirror({
      workspaceId: company.workspaceId,
      invoiceId: synced,
    })
    fake.state.failNext.set("POST invoice", [
      400,
      { Fault: { Error: [{ Message: "Bad item", code: "2500" }] } },
    ])
    await syncInvoiceMirror({
      workspaceId: company.workspaceId,
      invoiceId: failing,
    })
    const rows = (
      await db.execute<{
        id: string
        status: "open" | "paid"
        method: "stripeCheckout"
        createdAt: Date
      }>(sql`
        SELECT id, status, method, "createdAt" FROM "Invoice" WHERE "workspaceId" = ${company.workspaceId}`)
    ).rows.map((row) => ({ ...row, createdAt: new Date(row.createdAt) }))
    const states = await invoiceBookkeepingStates({
      workspaceId: company.workspaceId,
      invoices: [
        ...rows,
        {
          id: "1",
          status: "draft",
          method: "stripeCheckout",
          createdAt: new Date(),
        },
      ],
    })
    expect(states.get(synced)).toEqual({ state: "synced", error: null })
    expect(states.get(pending)).toEqual({ state: "pending", error: null })
    expect(states.get(failing)?.state).toBe("error")
    expect(states.has("1")).toBe(false)
  })

  test("the sweep finds an invoice whose copy was never queued", async () => {
    const company = await seedCompany({ mirror: true })
    const invoiceId = await seedCheckoutInvoice({
      ...company,
      status: "paid",
      number: 1,
    })
    m.enqueue.mockClear()
    await sweepInvoiceMirrors()
    expect(m.enqueue).toHaveBeenCalledWith(
      "syncInvoiceMirror",
      {
        type: "syncInvoiceMirror",
        data: { workspaceId: company.workspaceId, invoiceId },
      },
      expect.objectContaining({ jobId: expect.stringContaining(invoiceId) }),
    )
  })
})
