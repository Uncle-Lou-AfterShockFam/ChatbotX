// @vitest-environment node

/**
 * The hub invoice PDF (s210b) against a REAL Postgres: concurrent first
 * visits of `/pay/<token>/pdf` race on the ContactDocument (contactId, ref)
 * unique index. Gotenberg and the object store are in-memory fakes. What is
 * pinned: however many visits race, ONE row and ONE stored object survive,
 * every visit serves those bytes, and the losers' objects are deleted.
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

const TOKEN = "RDBinvoicePdf000000000"
const SERVE = { canServe: () => Promise.resolve(true) }

const m = vi.hoisted(() => ({
  objects: new Map<string, Buffer>(),
  puts: 0,
  deletes: 0,
  renders: 0,
}))

vi.mock("../../src/documents/gotenberg", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/documents/gotenberg")>()),
  htmlToPdf: async (html: string) => {
    m.renders += 1
    // Long enough for every racer to pass the SELECT-first before any insert.
    await new Promise((resolve) => setTimeout(resolve, 20))
    return {
      ok: true,
      pdf: new TextEncoder().encode(
        `%PDF-1.7 render ${m.renders} ${html.length} %%EOF`,
      ),
      ms: 20,
    }
  },
}))
vi.mock("@chatbotx.io/filesystem", () => ({
  uploader: {
    putObject: (path: string, body: Uint8Array) => {
      m.puts += 1
      m.objects.set(path, Buffer.from(body))
      return Promise.resolve()
    },
    getObject: (path: string) => {
      const found = m.objects.get(path)
      return found
        ? Promise.resolve(found)
        : Promise.reject(new Error(`NoSuchKey ${path}`))
    },
    deleteObject: (path: string) => {
      m.deletes += 1
      m.objects.delete(path)
      return Promise.resolve()
    },
    deleteByPrefix: async () => undefined,
  },
}))
vi.mock("../../src/audit/dispatcher", () => ({
  dispatchAuditRecord: vi.fn(async () => undefined),
}))

const databaseUrl = requireRealDatabaseUrl()

const { visitInvoicePdf } = await import("../../src/invoice/document")
const { documentService } = await import("../../src/documents/service")

let nextId = 9_210_000_000_000_000n
function mintId(): string {
  nextId += 1n
  return nextId.toString()
}

const seeded = { Contact: [] as string[], Workspace: [] as string[] }

async function asReplica(statement: ReturnType<typeof sql>): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`)
    await tx.execute(statement)
  })
}

async function seedCheckoutInvoice(status: "open" | "paid") {
  const workspaceId = mintId()
  const contactId = mintId()
  const invoiceId = mintId()
  await asReplica(sql`
    INSERT INTO "Workspace" (id, name, "ownerId")
    VALUES (${workspaceId}, ${`s210b pdf ${workspaceId}`}, 1)`)
  seeded.Workspace.push(workspaceId)
  await asReplica(sql`
    INSERT INTO "Contact" (id, "workspaceId", "firstName", email)
    VALUES (${contactId}, ${workspaceId}, 'Pat', 'pat@example.com')`)
  seeded.Contact.push(contactId)
  await asReplica(sql`
    INSERT INTO "Invoice" (id, "workspaceId", number, status, method, currency,
      total, "contactId", "payToken", "hostedUrl", "paidAt")
    VALUES (${invoiceId}, ${workspaceId}, 3, ${status}, 'stripeCheckout', 'USD',
      '12.50', ${contactId}, ${TOKEN}, ${`https://chat.example.org/pay/${TOKEN}`},
      ${status === "paid" ? new Date() : null})`)
  await asReplica(sql`
    INSERT INTO "InvoiceLineItem" (id, "invoiceId", position, description,
      quantity, "unitAmount", amount)
    VALUES (${mintId()}, ${invoiceId}, 0, 'Consult', 2, '5.00', '10.00'),
           (${mintId()}, ${invoiceId}, 1, 'Report', 1, '2.50', '2.50')`)
  return { workspaceId, contactId, invoiceId }
}

/** `count` documents created now on the contact, refs `<prefix><n>`. */
async function seedRecentDocuments(
  workspaceId: string,
  contactId: string,
  prefix: string,
  count: number,
) {
  for (let i = 0; i < count; i += 1) {
    const id = mintId()
    await asReplica(sql`
      INSERT INTO "ContactDocument" (id, "workspaceId", "contactId", title,
        ref, status, path, "fileSize", token, "tokenExpiresAt")
      VALUES (${id}, ${workspaceId}, ${contactId}, 'seed', ${`${prefix}${i}`},
        'generated', ${`workspaces/${workspaceId}/documents/${contactId}/${id}.pdf`},
        1, ${`RDB${id}`}, now() + interval '1 day')`)
  }
}

async function documentRows(contactId: string) {
  const result = await db.execute<{
    ref: string
    path: string
    title: string
  }>(sql`
    SELECT ref, path, title FROM "ContactDocument" WHERE "contactId" = ${contactId}`)
  return result.rows
}

beforeEach(() => {
  m.objects.clear()
  m.puts = 0
  m.deletes = 0
  m.renders = 0
})

afterEach(async () => {
  if (!databaseUrl) {
    return
  }
  const workspaces = seeded.Workspace.splice(0)
  if (workspaces.length > 0) {
    const list = sql.join(
      workspaces.map((id) => sql`${id}`),
      sql`, `,
    )
    await asReplica(
      sql`DELETE FROM "ContactDocument" WHERE "workspaceId" IN (${list})`,
    )
    await asReplica(sql`
      DELETE FROM "InvoiceLineItem" WHERE "invoiceId" IN
        (SELECT id FROM "Invoice" WHERE "workspaceId" IN (${list}))`)
    await asReplica(sql`DELETE FROM "Invoice" WHERE "workspaceId" IN (${list})`)
    const contacts = seeded.Contact.splice(0)
    await asReplica(sql`
      DELETE FROM "Contact" WHERE id IN (${sql.join(
        contacts.map((id) => sql`${id}`),
        sql`, `,
      )})`)
    await asReplica(sql`DELETE FROM "Workspace" WHERE id IN (${list})`)
  }
})

afterAll(async () => {
  if (!databaseUrl) {
    return
  }
  await db.$client.end()
})

describe.skipIf(!databaseUrl)(
  "/pay/<token>/pdf under concurrency (s210b)",
  () => {
    test("8 concurrent first visits: one row, one object, the same bytes for all", async () => {
      const { contactId, invoiceId } = await seedCheckoutInvoice("open")
      const visits = await Promise.all(
        Array.from({ length: 8 }, () => visitInvoicePdf(TOKEN, SERVE)),
      )
      const rows = await documentRows(contactId)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        ref: `invoice:${invoiceId}:invoice`,
        title: "Invoice #3",
      })
      // Every loser deleted its own object: exactly the winner's remains.
      expect([...m.objects.keys()]).toEqual([rows[0]?.path])
      expect(m.puts - m.deletes).toBe(1)
      const winner = m.objects.get(rows[0]?.path as string)
      for (const visit of visits) {
        expect(visit.kind).toBe("pdf")
        if (visit.kind === "pdf") {
          expect(visit.pdf.equals(winner as Buffer)).toBe(true)
        }
      }
    })

    test("a stored document is served again without a second render", async () => {
      const { contactId } = await seedCheckoutInvoice("paid")
      await visitInvoicePdf(TOKEN, SERVE)
      const renders = m.renders
      const again = await visitInvoicePdf(TOKEN, SERVE)
      expect(again).toMatchObject({ kind: "pdf", title: "Receipt #3" })
      expect(m.renders).toBe(renders)
      expect(await documentRows(contactId)).toHaveLength(1)
    })

    test("template renders do not spend the invoice budget, and invoice renders do not spend the template one", async () => {
      const { workspaceId, contactId } = await seedCheckoutInvoice("open")
      const now = new Date()
      // At its TEMPLATE limit, the workspace still renders the invoice PDF.
      await seedRecentDocuments(workspaceId, contactId, "manual:", 30)
      await expect(
        documentService.assertGenerateBudget({ workspaceId, now, tx: db }),
      ).rejects.toThrow("Too many documents")
      expect((await visitInvoicePdf(TOKEN, SERVE)).kind).toBe("pdf")
      // At its INVOICE limit (29 seeded + the one above), templates still generate.
      await seedRecentDocuments(workspaceId, contactId, "invoice:seed", 29)
      await expect(
        documentService.assertGenerateBudget({
          workspaceId,
          now,
          tx: db,
          kind: "invoice",
        }),
      ).rejects.toThrow("Too many documents")
      await asReplica(sql`
        DELETE FROM "ContactDocument"
         WHERE "workspaceId" = ${workspaceId} AND ref LIKE 'manual:%'`)
      await expect(
        documentService.assertGenerateBudget({ workspaceId, now, tx: db }),
      ).resolves.toBeUndefined()
    })
  },
)
