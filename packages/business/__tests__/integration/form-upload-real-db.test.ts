// @vitest-environment node

/**
 * Private web form uploads (s225a A2-4 PR 5) against a REAL Postgres: an
 * upload is a pending row + an object under `workspaces/<ws>/forms/<form>/`;
 * a submit claims it for its page load in one conditional UPDATE (exactly
 * one submission owns a row); the sweep deletes only unclaimed rows past
 * the TTL and skips a row a submit holds; the pending caps are counted
 * under a per-form lock; a delete removes the objects.
 *
 *     DATABASE_URL=postgres://... pnpm --filter @chatbotx.io/business test:db
 */

import { randomUUID } from "node:crypto"
import { db, sql } from "@chatbotx.io/database/client"
import { requireRealDatabaseUrl } from "@chatbotx.io/vitest-config/real-db"
import { afterAll, afterEach, describe, expect, test, vi } from "vitest"

const storage = vi.hoisted(() => ({
  putObject: vi.fn().mockResolvedValue({}),
  deleteObjects: vi.fn(async (keys: string[]) => ({
    deleted: new Set(keys).size,
  })),
  deleteByPrefix: vi.fn().mockResolvedValue({ deleted: 0 }),
}))
vi.mock("@chatbotx.io/filesystem", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chatbotx.io/filesystem")>()),
  uploader: storage,
}))
vi.mock("@chatbotx.io/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chatbotx.io/events")>()),
  emitFormSubmitted: vi.fn().mockResolvedValue(undefined),
  emitCustomFieldChanged: vi.fn().mockResolvedValue(undefined),
  emitFormAbandoned: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("@chatbotx.io/redis", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chatbotx.io/redis")>()),
  invalidateCacheByTags: vi.fn().mockResolvedValue(undefined),
  withCache: <T>(_key: string, fn: () => Promise<T>) => fn(),
}))
vi.mock("../../src/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const { formService } = await import("../../src/form/service")
const { formSubmitService } = await import("../../src/form/submit")
const {
  formUploadService,
  FORM_UPLOAD_PENDING_PER_IP,
  FORM_UPLOAD_PENDING_TTL_MS,
  FORM_UPLOAD_CLAIM_TTL_MS,
} = await import("../../src/form/upload")

const databaseUrl = requireRealDatabaseUrl()

let nextId = 9_225_100_000_000_000n + BigInt(Date.now() % 1_000_000_000) * 1000n
const mintId = (): string => {
  nextId += 1n
  return nextId.toString()
}
const seeded: Record<string, string[]> = {
  ContactCustomField: [],
  CustomField: [],
  Contact: [],
  Form: [],
  Workspace: [],
}

async function asReplica(statement: ReturnType<typeof sql>): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`)
    await tx.execute(statement)
  })
}

const PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  ),
)
const PDF = new TextEncoder().encode(
  "%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n",
)
const HTML = new TextEncoder().encode("<html><script>alert(1)</script></html>")

const DEF = JSON.stringify({
  steps: [
    {
      id: "s1",
      fields: [
        { key: "note", type: "text", label: "Note", required: true },
        { key: "photo", type: "image", label: "Photo" },
        { key: "doc", type: "file", label: "Doc", maxSizeMb: 1 },
      ],
    },
  ],
  rules: [],
})

async function seed() {
  const workspaceId = mintId()
  const formId = mintId()
  const slug = `upload-${formId}`
  await asReplica(
    sql`INSERT INTO "Workspace" (id, name, "ownerId") VALUES (${workspaceId}, 'a2-4-5', 1)`,
  )
  seeded.Workspace?.push(workspaceId)
  await asReplica(sql`
    INSERT INTO "Form" (id, title, slug, status, definition, "publishedDefinition",
                        "definitionVersion", settings, "workspaceId")
    VALUES (${formId}, 'Upload', ${slug}, 'published', ${DEF}::jsonb, ${DEF}::jsonb, 1,
            ${JSON.stringify({ channels: ["web"], submitLimitPerIpPerHour: 1000 })}::jsonb,
            ${workspaceId})`)
  seeded.Form?.push(formId)
  const form = await formService.findPublishedBySlug({ workspaceId, slug })
  if (!form) {
    throw new Error("seed: form not served")
  }
  return { workspaceId, formId, slug, form }
}
type Seeded = Awaited<ReturnType<typeof seed>>

const store = (
  w: Seeded,
  opts: {
    field?: string
    bytes?: Uint8Array
    v?: string
    ip?: string
    name?: unknown
    now?: Date
  } = {},
) =>
  formUploadService.store({
    form: w.form,
    fieldKey: opts.field ?? "photo",
    interactionId: opts.v ?? randomUUID(),
    clientIp: opts.ip ?? "198.51.100.50",
    bytes: opts.bytes ?? PNG,
    fileName: opts.name ?? "me.png",
    now: opts.now,
  })

const uploadId = async (
  w: Seeded,
  opts: Parameters<typeof store>[1] = {},
): Promise<string> => {
  const r = await store(w, opts)
  if (r.kind !== "ok") {
    throw new Error(`store: ${JSON.stringify(r)}`)
  }
  return r.uploadId
}

const submit = (
  w: Seeded,
  values: Record<string, unknown>,
  interactionId?: string,
) =>
  formSubmitService.submit({
    workspaceId: w.workspaceId,
    slug: w.slug,
    values: { note: "hi", ...values },
    honeypotFilled: false,
    clientIp: "198.51.100.51",
    userAgent: "vitest",
    interactionId,
  })

type UploadRow = {
  uploadId: string
  submissionId: string | null
  path: string
  mimeType: string
  fileName: string
  fieldKey: string
}
const uploads = async (formId: string): Promise<UploadRow[]> =>
  (
    await db.execute<UploadRow>(sql`
      SELECT "uploadId", "submissionId"::text, path, "mimeType", "fileName", "fieldKey"
        FROM "FormUpload" WHERE "formId" = ${formId} ORDER BY "createdAt", id`)
  ).rows

const age = (w: Seeded, ms: number) =>
  asReplica(sql`UPDATE "FormUpload" SET "createdAt" = now() - ${`${ms} milliseconds`}::interval
                 WHERE "formId" = ${w.formId}`)

afterEach(async () => {
  storage.putObject.mockClear()
  storage.putObject.mockResolvedValue({})
  storage.deleteObjects.mockClear()
  storage.deleteByPrefix.mockClear()
  if (!databaseUrl) {
    return
  }
  const forms = seeded.Form ?? []
  if (forms.length > 0) {
    const ids = sql.join(
      forms.map((id) => sql`${id}`),
      sql`, `,
    )
    await asReplica(sql`DELETE FROM "FormUpload" WHERE "formId" IN (${ids})`)
    await asReplica(
      sql`DELETE FROM "FormSubmission" WHERE "formId" IN (${ids})`,
    )
  }
  const contacts = seeded.Contact ?? []
  if (contacts.length > 0) {
    await asReplica(
      sql`DELETE FROM "ContactCustomField" WHERE "contactId" IN (${sql.join(
        contacts.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    )
  }
  for (const table of Object.keys(seeded)) {
    const ids = seeded[table]?.splice(0) ?? []
    if (ids.length > 0) {
      await asReplica(
        sql`DELETE FROM ${sql.identifier(table)} WHERE id IN (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      )
    }
  }
})

afterAll(async () => {
  if (databaseUrl) {
    await db.$client.end()
  }
})

describe.skipIf(!databaseUrl)("web form uploads (real Postgres)", () => {
  test("an image is stored privately under the form's prefix, typed by its bytes", async () => {
    const w = await seed()
    const r = await store(w, { name: "../../etc/pass\u202ewd.png" })
    expect(r).toMatchObject({ kind: "ok", sizeBytes: PNG.byteLength })
    const [row] = await uploads(w.formId)
    expect(row).toMatchObject({
      submissionId: null,
      mimeType: "image/png",
      fieldKey: "photo",
      fileName: "passwd.png",
    })
    expect(
      row?.path.startsWith(`workspaces/${w.workspaceId}/forms/${w.formId}/`),
    ).toBe(true)
    expect(row?.path).not.toContain("public/")
    expect(storage.putObject).toHaveBeenCalledWith(row?.path, PNG, {
      ContentType: "image/png",
    })
  })

  test("the sniffed type, the field's allowlist and its size cap decide; nothing is written on a refusal", async () => {
    const w = await seed()
    expect(await store(w, { field: "photo", bytes: PDF })).toEqual({
      kind: "invalid",
      code: "uploadType",
    })
    expect(
      await store(w, { field: "doc", bytes: HTML, name: "x.pdf" }),
    ).toEqual({
      kind: "invalid",
      code: "uploadType",
    })
    expect(await store(w, { field: "note" })).toEqual({
      kind: "invalid",
      code: "field",
    })
    expect(await store(w, { field: "__proto__" })).toEqual({
      kind: "invalid",
      code: "field",
    })
    const big = new Uint8Array(1024 * 1024 + 1)
    big.set(PDF.subarray(0, 5))
    big.set(PDF.subarray(PDF.length - 6), big.length - 6)
    expect(await store(w, { field: "doc", bytes: big })).toEqual({
      kind: "invalid",
      code: "uploadSize",
    })
    expect(await uploads(w.formId)).toHaveLength(0)
    expect(storage.putObject).not.toHaveBeenCalled()
    expect(await store(w, { field: "doc", bytes: PDF })).toMatchObject({
      kind: "ok",
    })
  })

  test("a failed object write removes its row and rethrows", async () => {
    const w = await seed()
    storage.putObject.mockRejectedValueOnce(new Error("store down"))
    await expect(store(w)).rejects.toThrow("store down")
    expect(await uploads(w.formId)).toHaveLength(0)
  })

  test("a submit claims its page load's upload; the row names the submission", async () => {
    const w = await seed()
    const v = randomUUID()
    const photo = await uploadId(w, { v })
    const res = await submit(w, { photo }, v)
    expect(res).toMatchObject({ kind: "ok", duplicate: false })
    const [row] = await uploads(w.formId)
    expect(row?.submissionId).toBe(res.kind === "ok" ? res.submissionId : "")
  })

  test("another page load, the wrong field, a missing v, a URL or an unknown id is refused, and nothing is stored", async () => {
    const w = await seed()
    const v = randomUUID()
    const photo = await uploadId(w, { v })
    const refused = { kind: "invalid", issues: [{ code: "upload" }] }
    expect(await submit(w, { photo }, randomUUID())).toMatchObject(refused)
    expect(await submit(w, { doc: photo }, v)).toMatchObject(refused)
    expect(await submit(w, { photo })).toMatchObject(refused)
    expect(await submit(w, { photo: `fu_${"A".repeat(43)}` }, v)).toMatchObject(
      refused,
    )
    expect(
      await submit(w, { photo: "https://evil.example/x.png" }, v),
    ).toMatchObject(refused)
    const n = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM "FormSubmission" WHERE "formId" = ${w.formId}`,
    )
    expect(n.rows[0]?.n).toBe(0)
    expect((await uploads(w.formId))[0]?.submissionId).toBeNull()
  })

  test("one upload named in two fields at once is refused", async () => {
    const w = await seed()
    const v = randomUUID()
    const doc = await uploadId(w, { v, field: "doc", bytes: PDF })
    expect(await submit(w, { photo: doc, doc }, v)).toMatchObject({
      kind: "invalid",
    })
    expect((await uploads(w.formId))[0]?.submissionId).toBeNull()
  })

  test("two racing submits with the same upload: exactly one claims it", async () => {
    const w = await seed()
    const v = randomUUID()
    const photo = await uploadId(w, { v })
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        submit(w, { photo, note: `n${i}` }, v),
      ),
    )
    const ok = results.filter((r) => r.kind === "ok")
    expect(ok).toHaveLength(1)
    expect(results.filter((r) => r.kind === "invalid")).toHaveLength(5)
    const subs = await db.execute<{ id: string }>(
      sql`SELECT id::text FROM "FormSubmission" WHERE "formId" = ${w.formId}`,
    )
    expect(subs.rows).toHaveLength(1)
    expect((await uploads(w.formId))[0]?.submissionId).toBe(subs.rows[0]?.id)
  })

  test("the claim window ends before the sweep's age", async () => {
    const w = await seed()
    const v = randomUUID()
    const photo = await uploadId(w, { v })
    await age(w, FORM_UPLOAD_CLAIM_TTL_MS + 60_000)
    expect(await submit(w, { photo }, v)).toMatchObject({ kind: "invalid" })
    // not yet the sweep's
    expect(await formUploadService.sweepExpired({ limit: 100 })).toBe(0)
    expect(await uploads(w.formId)).toHaveLength(1)
  })

  test("the sweep deletes expired unclaimed uploads (object, then row), never a claimed one", async () => {
    const w = await seed()
    const v = randomUUID()
    const kept = await uploadId(w, { v })
    await submit(w, { photo: kept }, v)
    await uploadId(w)
    await age(w, FORM_UPLOAD_PENDING_TTL_MS + 60_000)
    const rows = await uploads(w.formId)
    const pendingPath = rows.find((r) => r.submissionId === null)?.path
    expect(await formUploadService.sweepExpired({ limit: 100 })).toBe(1)
    expect(storage.deleteObjects).toHaveBeenCalledWith([pendingPath])
    const left = await uploads(w.formId)
    expect(left.map((r) => r.uploadId)).toEqual([kept])
  })

  test("a failed object delete keeps the rows for the next pass", async () => {
    const w = await seed()
    await uploadId(w)
    await age(w, FORM_UPLOAD_PENDING_TTL_MS + 60_000)
    storage.deleteObjects.mockResolvedValueOnce({
      deleted: 0,
      firstFailure: new Error("s3"),
    })
    await expect(
      formUploadService.sweepExpired({ limit: 100 }),
    ).rejects.toThrow("not deleted")
    expect(await uploads(w.formId)).toHaveLength(1)
    expect(await formUploadService.sweepExpired({ limit: 100 })).toBe(1)
    expect(await uploads(w.formId)).toHaveLength(0)
  })

  test("the sweep skips a row another transaction holds", async () => {
    const w = await seed()
    await uploadId(w)
    await age(w, FORM_UPLOAD_PENDING_TTL_MS + 60_000)
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let locked: () => void = () => undefined
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve
    })
    const holder = db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT id FROM "FormUpload" WHERE "formId" = ${w.formId} FOR UPDATE`,
      )
      locked()
      await held
    })
    await isLocked
    expect(await formUploadService.sweepExpired({ limit: 100 })).toBe(0)
    release()
    await holder
    expect(await uploads(w.formId)).toHaveLength(1)
  })

  test("parallel uploads from one ip stop at the pending cap", async () => {
    const w = await seed()
    const results = await Promise.all(
      Array.from({ length: FORM_UPLOAD_PENDING_PER_IP + 5 }, () =>
        store(w, { ip: "203.0.113.77" }),
      ),
    )
    expect(results.filter((r) => r.kind === "ok")).toHaveLength(
      FORM_UPLOAD_PENDING_PER_IP,
    )
    expect(results.filter((r) => r.kind === "rateLimited")).toHaveLength(5)
    // another visitor is not blocked by that one
    expect(await store(w, { ip: "203.0.113.78" })).toMatchObject({
      kind: "ok",
    })
  })

  test("deleting a submission removes its objects; deleting the form purges its prefix", async () => {
    const w = await seed()
    const v = randomUUID()
    const photo = await uploadId(w, { v })
    const res = await submit(w, { photo }, v)
    const path = (await uploads(w.formId))[0]?.path
    await formService.deleteSubmission({
      workspaceId: w.workspaceId,
      formId: w.formId,
      id: res.kind === "ok" ? (res.submissionId ?? "") : "",
    })
    expect(storage.deleteObjects).toHaveBeenCalledWith([path])
    expect(await uploads(w.formId)).toHaveLength(0)

    await formService.delete({ workspaceId: w.workspaceId, id: w.formId })
    expect(storage.deleteByPrefix).toHaveBeenCalledWith(
      `workspaces/${w.workspaceId}/forms/${w.formId}/`,
      {},
    )
  })

  test("findClaimed serves only a claimed upload of that workspace's form", async () => {
    const w = await seed()
    const other = await seed()
    const v = randomUUID()
    const photo = await uploadId(w, { v })
    const lookup = (ws: string, form: string, id: string) =>
      formUploadService.findClaimed({
        workspaceId: ws,
        formId: form,
        uploadId: id,
      })
    expect(await lookup(w.workspaceId, w.formId, photo)).toBeNull()
    await submit(w, { photo }, v)
    expect(await lookup(w.workspaceId, w.formId, photo)).toMatchObject({
      uploadId: photo,
    })
    expect(await lookup(other.workspaceId, w.formId, photo)).toBeNull()
    expect(await lookup(w.workspaceId, other.formId, photo)).toBeNull()
    expect(await lookup(w.workspaceId, w.formId, "fu_' OR 1=1 --")).toBeNull()
  })

  test("a web upload id is never written onto the contact; a chat answer's URL still is", async () => {
    const w = await seed()
    const contactId = mintId()
    const fieldId = mintId()
    await asReplica(
      sql`INSERT INTO "Contact" (id, "workspaceId") VALUES (${contactId}, ${w.workspaceId})`,
    )
    seeded.Contact?.push(contactId)
    await asReplica(sql`
      INSERT INTO "CustomField" (id, name, type, "workspaceId")
      VALUES (${fieldId}, ${`photo_${fieldId}`}, 'shortText', ${w.workspaceId})`)
    seeded.CustomField?.push(fieldId)
    const { formDefinition } = await import("@chatbotx.io/utils/form")
    const def = formDefinition.parse({
      steps: [
        {
          id: "s1",
          fields: [
            {
              key: "photo",
              type: "image",
              mapTo: { kind: "custom", customFieldId: fieldId },
            },
          ],
        },
      ],
      rules: [],
    })
    const write = (photo: string) =>
      db.transaction((tx) =>
        formSubmitService.writeMappedFields({
          workspaceId: w.workspaceId,
          contactId,
          def,
          values: { photo },
          fillBlanksOnly: false,
          tx,
        }),
      )
    const stored = async () =>
      (
        await db.execute<{ value: string }>(sql`
          SELECT value FROM "ContactCustomField"
           WHERE "contactId" = ${contactId} AND "customFieldId" = ${fieldId}`)
      ).rows.map((r) => r.value)
    await write(`fu_${"c".repeat(43)}`)
    expect(await stored()).toEqual([])
    await write("https://storage.example/public/ws/a.png")
    expect(await stored()).toEqual(["https://storage.example/public/ws/a.png"])
  })
})
