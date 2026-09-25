import { beforeEach, describe, expect, test, vi } from "vitest"

/**
 * Queue-driven mock at the query-builder seam (the deal-task-service pattern):
 * every SELECT / UPDATE / DELETE pops the next queued result; INSERT records
 * its values and returns them unless `insertConflict` is set.
 */
const m = vi.hoisted(() => {
  const state = {
    selects: [] as unknown[][],
    updates: [] as unknown[][],
    deletes: [] as unknown[][],
    inserted: [] as Record<string, unknown>[],
    insertConflict: false,
    insertError: null as Error | null,
    calls: [] as string[],
  }
  const chain = (kind: "select" | "update" | "delete") => {
    const self: Record<string, unknown> = {}
    const queues = {
      select: state.selects,
      update: state.updates,
      delete: state.deletes,
    }
    for (const k of ["from", "where", "orderBy", "limit", "set", "returning"]) {
      self[k] = () => self
    }
    // biome-ignore lint/suspicious/noThenProperty: awaitable like a drizzle query
    self.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => {
      const next = queues[kind].shift()
      if (next === undefined) {
        return Promise.reject(
          new Error(`mock: no ${kind} queued (${state.calls.join(",")})`),
        ).then(ok, ko)
      }
      return Promise.resolve(next).then(ok, ko)
    }
    return self
  }
  const tx = {
    select: () => {
      state.calls.push("select")
      return chain("select")
    },
    update: () => {
      state.calls.push("update")
      return chain("update")
    },
    delete: () => {
      state.calls.push("delete")
      return chain("delete")
    },
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        const done = {
          onConflictDoNothing: () => done,
          returning: () => {
            state.calls.push("insert")
            if (state.insertError) {
              return Promise.reject(state.insertError)
            }
            if (state.insertConflict) {
              return Promise.resolve([])
            }
            const row = { ...v, createdAt: new Date(), updatedAt: new Date() }
            state.inserted.push(row)
            return Promise.resolve([row])
          },
        }
        return done
      },
    }),
  }
  return {
    state,
    tx,
    htmlToPdf: vi.fn(),
    putObject: vi.fn(() => {
      state.calls.push("put")
      return Promise.resolve()
    }),
    deleteObject: vi.fn(() => {
      state.calls.push("deleteObject")
      return Promise.resolve()
    }),
  }
})

vi.mock("@chatbotx.io/database/client", () => ({
  db: m.tx,
  and: (...c: unknown[]) => ({ c }),
  eq: (f: unknown, v: unknown) => ({ f, v }),
  gte: (f: unknown, v: unknown) => ({ gte: [f, v] }),
  desc: (f: unknown) => ({ desc: f }),
}))
vi.mock("@chatbotx.io/database/schema", () => ({
  contactDocumentModel: { contactId: "contactId", ref: "ref" },
  contactModel: { id: "id", workspaceId: "ws" },
  documentTemplateModel: {
    id: "id",
    workspaceId: "ws",
    status: "status",
    updatedAt: "u",
  },
}))
vi.mock("@chatbotx.io/filesystem", () => ({
  uploader: { putObject: m.putObject, deleteObject: m.deleteObject },
}))
vi.mock("../src/documents/gotenberg", () => ({ htmlToPdf: m.htmlToPdf }))
vi.mock("@chatbotx.io/utils", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createId: (() => {
    let n = 0
    return () => `id-${++n}`
  })(),
}))

import {
  CONTACT_DOCUMENT_TOKEN_LENGTH,
  contactDocumentPath,
  documentService,
  isContactDocumentToken,
  mintContactDocumentToken,
} from "../src/documents/service"

const PUBLIC_PREFIX_RE = /^public\//
const ARCHIVED_RE = /archived/
const MAY_NOT_CONTAIN_RE = /may not contain/
const TOO_MANY_RE = /Too many documents/
const DUPLICATE_RE = /duplicate key/
const RENDER_TIMEOUT_RE = /Could not render the PDF \(timeout\)/
const WS = "11701868563365888"
const CID = "11702341840011264"
const TEMPLATE = {
  id: "t1",
  workspaceId: WS,
  name: "Consent",
  status: "active",
  bodyHtml: "<p>Hi {{first_name}}</p><span>{{signature, r1}}</span>",
}
const PDF = new TextEncoder().encode("%PDF-1.4 x %%EOF")
const resolveVariables = vi.fn(async (keys: string[]) =>
  Object.fromEntries(
    keys.filter((k) => k === "first_name").map((k) => [k, "Ada <3"]),
  ),
)
const NOW = new Date("2026-09-25T00:00:00Z")

beforeEach(() => {
  m.state.selects.length = 0
  m.state.updates.length = 0
  m.state.deletes.length = 0
  m.state.inserted.length = 0
  m.state.calls.length = 0
  m.state.insertConflict = false
  m.state.insertError = null
  m.htmlToPdf.mockReset()
  m.htmlToPdf.mockResolvedValue({ ok: true, pdf: PDF, ms: 5 })
  m.putObject.mockClear()
  m.deleteObject.mockClear()
  resolveVariables.mockClear()
})

describe("documentService.generateForContact", () => {
  test("renders the template for the contact, escapes values, stores a private PDF and a 30-day token", async () => {
    // findByRef (none), contact, template
    m.state.selects.push([], [{ id: CID }], [], [TEMPLATE])
    const { document, created } = await documentService.generateForContact({
      workspaceId: WS,
      contactId: CID,
      templateId: "t1",
      ref: "consent-v1",
      resolveVariables,
      now: NOW,
    })
    expect(created).toBe(true)
    expect(resolveVariables).toHaveBeenCalledWith([
      "first_name",
      "signature, r1",
    ])
    const html = String(m.htmlToPdf.mock.calls[0][0])
    expect(html).toContain("Hi Ada &lt;3")
    expect(html).toContain("{{signature, r1}}")
    expect(m.putObject).toHaveBeenCalledWith(
      `workspaces/${WS}/documents/${CID}/${document.id}.pdf`,
      PDF,
      { ContentType: "application/pdf" },
    )
    expect(document.path).not.toMatch(PUBLIC_PREFIX_RE)
    expect(document).toMatchObject({
      ref: "consent-v1",
      status: "generated",
      title: "Consent",
      fileSize: PDF.length,
      templateId: "t1",
    })
    expect(isContactDocumentToken(document.token)).toBe(true)
    expect((document.tokenExpiresAt as Date).toISOString()).toBe(
      "2026-10-25T00:00:00.000Z",
    )
  })

  test("the same ref returns the stored row without rendering; a ref from another workspace is not found", async () => {
    const stored = {
      id: "d1",
      workspaceId: WS,
      contactId: CID,
      ref: "consent-v1",
    }
    m.state.selects.push([stored])
    expect(
      await documentService.generateForContact({
        workspaceId: WS,
        contactId: CID,
        templateId: "t1",
        ref: "consent-v1",
        resolveVariables,
      }),
    ).toEqual({ document: stored, created: false })
    expect(m.htmlToPdf).not.toHaveBeenCalled()
    m.state.selects.push([{ ...stored, workspaceId: "999" }])
    await expect(
      documentService.generateForContact({
        workspaceId: WS,
        contactId: CID,
        templateId: "t1",
        ref: "consent-v1",
        resolveVariables,
      }),
    ).rejects.toMatchObject({ httpStatusCode: 404 })
  })

  test("losing the ref race deletes the orphan object and answers the winner", async () => {
    const winner = { id: "d9", workspaceId: WS, contactId: CID, ref: "r" }
    m.state.selects.push([], [{ id: CID }], [], [TEMPLATE], [winner])
    m.state.insertConflict = true
    const r = await documentService.generateForContact({
      workspaceId: WS,
      contactId: CID,
      templateId: "t1",
      ref: "r",
      resolveVariables,
    })
    expect(r).toEqual({ document: winner, created: false })
    expect(m.state.calls).toContain("deleteObject")
  })

  test("refusals: bad ref, foreign contact, archived template, merge value with braces, Gotenberg failure", async () => {
    const base = {
      workspaceId: WS,
      contactId: CID,
      templateId: "t1",
      resolveVariables,
    }
    for (const ref of ["", "a b", "x".repeat(101), "../x"]) {
      await expect(
        documentService.generateForContact({ ...base, ref }),
      ).rejects.toMatchObject({ httpStatusCode: 422 })
    }
    m.state.selects.push([], [])
    await expect(
      documentService.generateForContact({ ...base, ref: "a" }),
    ).rejects.toMatchObject({ httpStatusCode: 404 })
    m.state.selects.push(
      [],
      [{ id: CID }],
      [],
      [{ ...TEMPLATE, status: "archived" }],
    )
    await expect(
      documentService.generateForContact({ ...base, ref: "b" }),
    ).rejects.toThrow(ARCHIVED_RE)
    m.state.selects.push([], [{ id: CID }], [], [TEMPLATE])
    await expect(
      documentService.generateForContact({
        ...base,
        ref: "c",
        resolveVariables: async () => ({ first_name: "{{signature, r2}}" }),
      }),
    ).rejects.toThrow(MAY_NOT_CONTAIN_RE)
    m.state.selects.push([], [{ id: CID }], [], [TEMPLATE])
    m.htmlToPdf.mockResolvedValueOnce({
      ok: false,
      status: null,
      error: "timeout",
    })
    await expect(
      documentService.generateForContact({ ...base, ref: "d" }),
    ).rejects.toThrow(RENDER_TIMEOUT_RE)
    expect(m.putObject).not.toHaveBeenCalled()
  })
})

describe("documentService templates + download", () => {
  test("template data is validated: name length, empty body, size cap", async () => {
    for (const data of [
      { name: "", bodyHtml: "<p>x</p>" },
      { name: "x".repeat(121), bodyHtml: "<p>x</p>" },
      { name: "A", bodyHtml: "  " },
      { name: "A", bodyHtml: "x".repeat(200_001) },
    ]) {
      await expect(
        documentService.createTemplate({ workspaceId: WS, data }),
      ).rejects.toMatchObject({ httpStatusCode: 422 })
    }
    const row = await documentService.createTemplate({
      workspaceId: WS,
      userId: "u1",
      data: { name: "  Consent ", bodyHtml: "<p>x</p>" },
    })
    expect(row).toMatchObject({
      name: "Consent",
      workspaceId: WS,
      status: "active",
      createdById: "u1",
    })
    m.state.updates.push([])
    await expect(
      documentService.updateTemplate({
        workspaceId: WS,
        id: "nope",
        data: { name: "A", bodyHtml: "<p>x</p>" },
      }),
    ).rejects.toMatchObject({ httpStatusCode: 404 })
    m.state.deletes.push([])
    await expect(
      documentService.deleteTemplate({ workspaceId: WS, id: "nope" }),
    ).rejects.toMatchObject({ httpStatusCode: 404 })
  })

  test("resolveDownload: invalid, unknown, expired, no file; the signed copy wins", async () => {
    const token = mintContactDocumentToken()
    expect(await documentService.resolveDownload({ token: "short" })).toEqual({
      ok: false,
      reason: "invalid",
    })
    expect(
      await documentService.resolveDownload({ token: `${token.slice(1)}!` }),
    ).toEqual({ ok: false, reason: "invalid" })
    m.state.selects.push([])
    expect(await documentService.resolveDownload({ token })).toEqual({
      ok: false,
      reason: "not-found",
    })
    m.state.selects.push([
      { token, tokenExpiresAt: new Date("2026-09-24T00:00:00Z"), path: "p" },
    ])
    expect(await documentService.resolveDownload({ token, now: NOW })).toEqual({
      ok: false,
      reason: "expired",
    })
    m.state.selects.push([
      {
        token,
        tokenExpiresAt: new Date("2026-10-01T00:00:00Z"),
        path: null,
        signedPath: null,
      },
    ])
    expect(await documentService.resolveDownload({ token, now: NOW })).toEqual({
      ok: false,
      reason: "no-file",
    })
    m.state.selects.push([
      {
        token,
        tokenExpiresAt: new Date("2026-10-01T00:00:00Z"),
        path: "p",
        signedPath: "s",
      },
    ])
    expect(
      await documentService.resolveDownload({ token, now: NOW }),
    ).toMatchObject({ ok: true, path: "s" })
  })

  test("tokens are 22 base62 chars from 128 random bits; paths are private", () => {
    const zeros = mintContactDocumentToken(() => new Uint8Array(16))
    expect(zeros).toBe("0".repeat(CONTACT_DOCUMENT_TOKEN_LENGTH))
    const seen = new Set(
      Array.from({ length: 200 }, () => mintContactDocumentToken()),
    )
    expect(seen.size).toBe(200)
    expect(contactDocumentPath("1", "2", "3")).toBe(
      "workspaces/1/documents/2/3.pdf",
    )
  })
})

describe("documentService hardening (skeptic + blind probe s197c)", () => {
  const base = {
    workspaceId: WS,
    contactId: CID,
    templateId: "t1",
    resolveVariables,
  }

  test("the generation budget refuses past DOCUMENT_GENERATE_PER_MINUTE renders", async () => {
    m.state.selects.push(
      [],
      [{ id: CID }],
      Array.from({ length: 30 }, (_, i) => ({ id: `d${i}` })),
    )
    await expect(
      documentService.generateForContact({ ...base, ref: "busy" }),
    ).rejects.toThrow(TOO_MANY_RE)
    expect(m.htmlToPdf).not.toHaveBeenCalled()
  })

  test("an insert failure deletes the stored object; a storage failure is a typed 422", async () => {
    m.state.selects.push([], [{ id: CID }], [], [TEMPLATE])
    m.state.insertError = new Error(
      "duplicate key value violates unique constraint",
    )
    await expect(
      documentService.generateForContact({ ...base, ref: "x1" }),
    ).rejects.toThrow(DUPLICATE_RE)
    expect(m.state.calls).toContain("deleteObject")
    m.state.insertError = null
    m.state.selects.push([], [{ id: CID }], [], [TEMPLATE])
    m.putObject.mockRejectedValueOnce(new Error("NoSuchBucket"))
    await expect(
      documentService.generateForContact({ ...base, ref: "x2" }),
    ).rejects.toMatchObject({ httpStatusCode: 422 })
  })

  test("a non-string resolver value is a typed 422, never a raw TypeError", async () => {
    m.state.selects.push([], [{ id: CID }], [], [TEMPLATE])
    await expect(
      documentService.generateForContact({
        ...base,
        ref: "x3",
        resolveVariables: async () => ({ first_name: 5 as unknown as string }),
      }),
    ).rejects.toMatchObject({ httpStatusCode: 422 })
  })

  test("templates with active markup are refused at save", async () => {
    for (const bodyHtml of [
      "<p>x</p><script>1</script>",
      '<img src="x" onerror="1">',
      '<iframe src="http://169.254.169.254/"></iframe>',
      '<meta http-equiv="refresh" content="0;url=http://x">',
      '<a href="javascript:alert(1)">x</a>',
      "<svg><image href=x /></svg>",
      "<LINK rel=stylesheet href=//x>",
    ]) {
      await expect(
        documentService.createTemplate({
          workspaceId: WS,
          data: { name: "A", bodyHtml },
        }),
      ).rejects.toMatchObject({ httpStatusCode: 422 })
    }
  })

  test("an empty signedPath falls back to the generated file", async () => {
    const token = mintContactDocumentToken()
    m.state.selects.push([
      {
        token,
        tokenExpiresAt: new Date("2026-10-01T00:00:00Z"),
        path: "p",
        signedPath: "",
      },
    ])
    expect(
      await documentService.resolveDownload({ token, now: NOW }),
    ).toMatchObject({ ok: true, path: "p" })
  })
})
