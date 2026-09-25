import { beforeEach, describe, expect, test, vi } from "vitest"

/**
 * Queue-driven mock at the query-builder seam (as documents-service.test):
 * every SELECT / UPDATE pops the next queued result and records its `.set()`.
 */
const m = vi.hoisted(() => {
  const state = {
    selects: [] as unknown[][],
    updates: [] as unknown[][],
    sets: [] as Record<string, unknown>[],
    calls: [] as string[],
  }
  const chain = (kind: "select" | "update") => {
    const self: Record<string, unknown> = {}
    for (const k of ["from", "where", "limit", "returning"]) {
      self[k] = () => self
    }
    self.set = (v: Record<string, unknown>) => {
      state.sets.push(v)
      return self
    }
    // biome-ignore lint/suspicious/noThenProperty: awaitable like a drizzle query
    self.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => {
      const queue = kind === "select" ? state.selects : state.updates
      const next = queue.shift()
      return (
        next === undefined
          ? Promise.reject(new Error(`mock: no ${kind} queued`))
          : Promise.resolve(next)
      ).then(ok, ko)
    }
    return self
  }
  return {
    state,
    tx: {
      select: () => {
        state.calls.push("select")
        return chain("select")
      },
      update: () => {
        state.calls.push("update")
        return chain("update")
      },
    },
    generateForContact: vi.fn(),
    getObject: vi.fn(),
    putObject: vi.fn(),
    attach: vi.fn(),
  }
})

vi.mock("@chatbotx.io/database/client", () => ({
  db: m.tx,
  and: (...c: unknown[]) => ({ c }),
  eq: (f: unknown, v: unknown) => ({ f, v }),
  ne: (f: unknown, v: unknown) => ({ ne: [f, v] }),
  isNull: (f: unknown) => ({ isNull: f }),
}))
vi.mock("@chatbotx.io/database/schema", () => ({
  contactDocumentModel: {
    id: "id",
    status: "status",
    documensoEnvelopeId: "env",
    signedAt: "signedAt",
  },
}))
vi.mock("@chatbotx.io/filesystem", () => ({
  uploader: { getObject: m.getObject, putObject: m.putObject },
}))
vi.mock("../src/tag/service", () => ({
  tagService: { attachByNamesToContacts: m.attach },
}))
vi.mock("../src/documents/service", () => ({
  documentService: { generateForContact: m.generateForContact },
}))

import type { DocumensoClient } from "../src/documents/documenso"
import {
  DOCUMENT_SIGNED_TAG,
  DocumentSigningService,
  signedDocumentPath,
  verifyDocumensoSecret,
  verifySignableEnvelope,
} from "../src/documents/signing"

const NO_SIGNATURE_REGEX = /no signature field/
const VERIFY_NO_SIGNATURE_REGEX = /^verify: no signature field/
const ENV_ID = "envelope_abcdefgh12"
const EMAIL = "sig+c1@example.org"
const PDF = new TextEncoder().encode("%PDF-1.4 x %%EOF")
const row = (over: Record<string, unknown> = {}) => ({
  id: "101",
  workspaceId: "w1",
  contactId: "c1",
  title: "Consent",
  ref: "sig:x",
  status: "generated",
  path: "workspaces/w1/documents/c1/101.pdf",
  documensoEnvelopeId: null,
  documensoDocumentId: null,
  signingUrl: null,
  ...over,
})
const signable = (over: Record<string, unknown> = {}) => ({
  status: "DRAFT",
  externalId: "cbxdoc:101",
  secondaryId: "document_42",
  recipients: [{ id: 9, email: EMAIL }],
  fields: [{ type: "SIGNATURE", recipientId: 9 }],
  ...over,
})
const fakeClient = (over: Partial<DocumensoClient> = {}): DocumensoClient => ({
  createEnvelope: vi.fn(async () => ({
    ok: true as const,
    status: 200,
    envelopeId: ENV_ID,
  })),
  getEnvelope: vi.fn(async () => ({
    ok: true as const,
    status: 200,
    body: signable(),
  })),
  distributeEnvelope: vi.fn(async () => ({
    ok: true as const,
    status: 200,
    body: { recipients: [{ email: EMAIL, signingUrl: "https://sig/s/tok" }] },
  })),
  deleteEnvelope: vi.fn(async () => ({
    ok: true as const,
    status: 200,
    body: { success: true },
  })),
  downloadSignedItem: vi.fn(async () => ({
    ok: true as const,
    status: 200,
    pdf: PDF,
  })),
  ...over,
})

const svc = new DocumentSigningService()
const send = (documenso: DocumensoClient | undefined = fakeClient()) =>
  svc.sendForSignature({
    workspaceId: "w1",
    contactId: "c1",
    templateId: "t1",
    ref: "sig:x",
    signerName: "Ada",
    resolveVariables: async () => ({}),
    documenso,
    signerDomain: "example.org",
  })

beforeEach(() => {
  vi.clearAllMocks()
  m.state.selects.length = 0
  m.state.updates.length = 0
  m.state.sets.length = 0
  m.state.calls.length = 0
  m.getObject.mockResolvedValue(Buffer.from(PDF))
  m.putObject.mockResolvedValue(undefined)
  m.attach.mockResolvedValue({ processedContactIds: ["c1"] })
})

describe("verifySignableEnvelope", () => {
  test("accepts our DRAFT/PENDING envelope with a signature field for our signer", () => {
    expect(verifySignableEnvelope(signable(), "cbxdoc:101", EMAIL)).toEqual({
      documentId: 42,
    })
    expect(
      verifySignableEnvelope(
        signable({ status: "PENDING" }),
        "cbxdoc:101",
        EMAIL,
      ),
    ).toEqual({ documentId: 42 })
  })

  test("names why an envelope cannot be signed", () => {
    const v = (over: Record<string, unknown>) =>
      verifySignableEnvelope(signable(over), "cbxdoc:101", EMAIL)
    expect(v({ status: "COMPLETED" })).toBe("status COMPLETED")
    expect(v({ externalId: "cbxdoc:102" })).toBe("externalId mismatch")
    expect(v({ secondaryId: "document_0" })).toBe("no secondaryId")
    expect(v({ secondaryId: undefined })).toBe("no secondaryId")
    // Documenso's id is an int4 column here: a larger one is refused.
    expect(v({ secondaryId: "document_2147483648" })).toBe("no secondaryId")
    expect(v({ secondaryId: "document_9999999999999999" })).toBe(
      "no secondaryId",
    )
    expect(v({ recipients: [{ id: 9, email: "x@y.z" }] })).toBe(
      "signer missing",
    )
    // An id-less signer must not match an id-less field.
    expect(
      v({ recipients: [{ email: EMAIL }], fields: [{ type: "SIGNATURE" }] }),
    ).toBe("signer missing")
    expect(v({ fields: [{ type: "DATE", recipientId: 9 }] })).toMatch(
      NO_SIGNATURE_REGEX,
    )
    expect(v({ recipients: "junk", fields: null })).toBe("signer missing")
  })
})

describe("sendForSignature", () => {
  test("not configured: no client or no signer domain, nothing rendered", async () => {
    const r = await svc.sendForSignature({
      workspaceId: "w1",
      contactId: "c1",
      templateId: "t1",
      ref: "sig:x",
      signerName: "Ada",
      resolveVariables: async () => ({}),
      documenso: fakeClient(),
      signerDomain: "",
    })
    expect(r).toEqual({ ok: false, stage: "config", error: "not-configured" })
    expect(m.generateForContact).not.toHaveBeenCalled()
  })

  test("a render failure is a value at stage render", async () => {
    m.generateForContact.mockRejectedValue(
      new Error("Could not render the PDF (timeout)"),
    )
    expect(await send()).toEqual({
      ok: false,
      stage: "render",
      error: "Could not render the PDF (timeout)",
    })
  })

  test("happy path: create from the stored PDF, claim, verify, distribute, stamp sent", async () => {
    m.generateForContact.mockResolvedValue({ document: row(), created: true })
    m.state.updates.push([{ envelopeId: ENV_ID }], [row({ status: "sent" })])
    const client = fakeClient()
    const r = await send(client)
    expect(r).toMatchObject({
      ok: true,
      reused: false,
      signingUrl: "https://sig/s/tok",
      documensoDocumentId: 42,
    })
    expect(m.getObject).toHaveBeenCalledWith(
      "workspaces/w1/documents/c1/101.pdf",
    )
    expect(client.createEnvelope).toHaveBeenCalledWith({
      pdf: Buffer.from(PDF),
      title: "Consent",
      externalId: "cbxdoc:101",
      recipient: { email: EMAIL, name: "Ada" },
    })
    expect(m.state.sets[1]).toMatchObject({
      status: "sent",
      signingUrl: "https://sig/s/tok",
      documensoDocumentId: 42,
      error: null,
    })
  })

  test("a sent row with a link is reused: no Documenso call at all", async () => {
    m.generateForContact.mockResolvedValue({
      document: row({
        status: "sent",
        signingUrl: "https://sig/s/old",
        documensoDocumentId: 7,
        documensoEnvelopeId: ENV_ID,
      }),
      created: false,
    })
    const client = fakeClient()
    expect(await send(client)).toMatchObject({
      ok: true,
      reused: true,
      signingUrl: "https://sig/s/old",
      documensoDocumentId: 7,
    })
    expect(client.createEnvelope).not.toHaveBeenCalled()
    expect(client.distributeEnvelope).not.toHaveBeenCalled()
  })

  test("a retry with an envelope already recorded skips create and re-distributes", async () => {
    m.generateForContact.mockResolvedValue({
      document: row({ documensoEnvelopeId: ENV_ID }),
      created: false,
    })
    m.state.updates.push([row({ status: "sent" })])
    const client = fakeClient()
    expect((await send(client)).ok).toBe(true)
    expect(client.createEnvelope).not.toHaveBeenCalled()
    expect(client.getEnvelope).toHaveBeenCalledWith(ENV_ID)
  })

  test("losing the envelope claim uses the winner's envelope", async () => {
    m.generateForContact.mockResolvedValue({ document: row(), created: true })
    m.state.updates.push([], [row({ status: "sent" })])
    m.state.selects.push([{ envelopeId: "envelope_winner000" }])
    const client = fakeClient()
    expect((await send(client)).ok).toBe(true)
    expect(client.getEnvelope).toHaveBeenCalledWith("envelope_winner000")
    // Ours is deleted, so no untracked copy of the document stays in Documenso.
    expect(client.deleteEnvelope).toHaveBeenCalledWith(ENV_ID)
  })

  test("an unsignable envelope is forgotten (so a retry opens a fresh one) and the reason kept", async () => {
    m.generateForContact.mockResolvedValue({
      document: row({ documensoEnvelopeId: ENV_ID }),
      created: false,
    })
    m.state.updates.push([], [])
    const client = fakeClient({
      getEnvelope: vi.fn(async () => ({
        ok: true as const,
        status: 200,
        body: signable({ fields: [] }),
      })),
    })
    const r = await send(client)
    expect(r).toMatchObject({ ok: false, stage: "verify" })
    expect(m.state.sets[0]).toMatchObject({ documensoEnvelopeId: null })
    expect(client.deleteEnvelope).toHaveBeenCalledWith(ENV_ID)
    expect(String(m.state.sets[1].error)).toMatch(VERIFY_NO_SIGNATURE_REGEX)
    expect(client.distributeEnvelope).not.toHaveBeenCalled()
  })

  test("each upstream failure stops at its stage and records it on the row", async () => {
    const cases: [Partial<DocumensoClient>, string][] = [
      [
        {
          createEnvelope: vi.fn(async () => ({
            ok: false as const,
            status: 500,
            error: "http-500",
          })),
        },
        "create",
      ],
      [
        {
          getEnvelope: vi.fn(async () => ({
            ok: false as const,
            status: null,
            error: "timeout",
          })),
        },
        "verify",
      ],
      [
        {
          distributeEnvelope: vi.fn(async () => ({
            ok: true as const,
            status: 200,
            body: {
              recipients: [{ email: EMAIL, signingUrl: "http://plain/x" }],
            },
          })),
        },
        "distribute",
      ],
    ]
    for (const [over, stage] of cases) {
      m.state.sets.length = 0
      m.state.updates.length = 0
      m.generateForContact.mockResolvedValue({ document: row(), created: true })
      // create fails before the envelope claim; the others claim, then fail.
      if (stage !== "create") {
        m.state.updates.push([{ envelopeId: ENV_ID }])
      }
      m.state.updates.push([])
      const r = await send(fakeClient(over))
      expect(r).toMatchObject({ ok: false, stage })
      expect(String(m.state.sets.at(-1)?.error)).toMatch(
        new RegExp(`^${stage}:`),
      )
    }
  })

  test("an unreadable stored PDF fails at render without calling Documenso", async () => {
    m.generateForContact.mockResolvedValue({ document: row(), created: true })
    m.getObject.mockRejectedValue(new Error("NoSuchKey"))
    m.state.updates.push([])
    const client = fakeClient()
    expect(await send(client)).toMatchObject({ ok: false, stage: "render" })
    expect(client.createEnvelope).not.toHaveBeenCalled()
  })
})

describe("sendForSignature edge cases", () => {
  test("a COMPLETED envelope is kept (never forgotten or deleted): the webhook owns it", async () => {
    m.generateForContact.mockResolvedValue({
      document: row({ documensoEnvelopeId: ENV_ID }),
      created: false,
    })
    m.state.updates.push([])
    const client = fakeClient({
      getEnvelope: vi.fn(async () => ({
        ok: true as const,
        status: 200,
        body: signable({ status: "COMPLETED" }),
      })),
    })
    expect(await send(client)).toMatchObject({ ok: false, stage: "verify" })
    expect(client.deleteEnvelope).not.toHaveBeenCalled()
    expect(m.state.sets).toHaveLength(1)
    expect(m.state.sets[0]).not.toHaveProperty("documensoEnvelopeId")
  })

  test("a signing link is stored normalised; whitespace or control characters refuse it", async () => {
    for (const [raw, stored] of [
      ["https://SIG.example/s/tok", "https://sig.example/s/tok"],
      ["https://sig/s/tok\nReply YES to win", null],
      ["https://sig/s/tok tail", null],
      ["\thttps://sig/s/tok", null],
    ] as const) {
      m.state.updates.length = 0
      m.state.sets.length = 0
      m.generateForContact.mockResolvedValue({ document: row(), created: true })
      m.state.updates.push([{ envelopeId: ENV_ID }], [row({ status: "sent" })])
      const r = await send(
        fakeClient({
          distributeEnvelope: vi.fn(async () => ({
            ok: true as const,
            status: 200,
            body: { recipients: [{ email: EMAIL, signingUrl: raw }] },
          })),
        }),
      )
      if (stored === null) {
        expect(r).toMatchObject({ ok: false, stage: "distribute" })
      } else {
        expect(r).toMatchObject({ ok: true, signingUrl: stored })
      }
    }
  })
})

describe("completeFromWebhook", () => {
  const completed = (over: Record<string, unknown> = {}) => ({
    event: "DOCUMENT_COMPLETED",
    payload: { id: 42, externalId: "cbxdoc:101", status: "COMPLETED", ...over },
  })
  const sent = row({
    status: "sent",
    documensoEnvelopeId: ENV_ID,
    documensoDocumentId: 42,
  })
  const completeEnvelope = (over: Record<string, unknown> = {}) =>
    vi.fn(async () => ({
      ok: true as const,
      status: 200,
      body: {
        status: "COMPLETED",
        externalId: "cbxdoc:101",
        envelopeItems: [{ id: "item_1" }],
        ...over,
      },
    }))
  const hook = (body: unknown, documenso = fakeClient()) =>
    svc.completeFromWebhook({
      body,
      documenso,
      now: new Date("2026-09-25T04:00:00Z"),
    })

  test("non-completion events and junk bodies are ignored without a DB read", async () => {
    for (const body of [
      null,
      "x",
      [],
      {},
      { event: 7 },
      { event: "DOCUMENT_SIGNED", payload: {} },
      { event: "DOCUMENT_OPENED" },
    ]) {
      expect((await hook(body)).outcome).toBe("ignored")
    }
    expect(m.state.calls).toEqual([])
  })

  test("a completion that is not one of our documents is unknown (final)", async () => {
    for (const payload of [
      undefined,
      { externalId: "cbx:123" },
      { externalId: "cbxdoc:0" },
      { externalId: "cbxdoc:1 OR 1=1" },
      { externalId: "cbxdoc:99999999999999999999" },
      { externalId: "cbxdoc:9223372036854775808" },
      { externalId: 5 },
    ]) {
      expect(
        (await hook({ event: "DOCUMENT_COMPLETED", payload })).outcome,
      ).toBe("unknown")
    }
    m.state.selects.push([])
    expect((await hook(completed())).outcome).toBe("unknown")
  })

  test("already signed = duplicate, nothing re-tagged", async () => {
    m.state.selects.push([row({ status: "signed" })])
    expect((await hook(completed())).outcome).toBe("duplicate")
    expect(m.attach).not.toHaveBeenCalled()
  })

  test("a forged completion is refused: never sent, other Documenso id, or Documenso disagrees", async () => {
    m.state.selects.push([row()])
    expect((await hook(completed())).outcome).toBe("unconfirmed")
    m.state.selects.push([sent])
    expect((await hook(completed({ id: 43 }))).outcome).toBe("unconfirmed")
    for (const over of [
      { status: "REJECTED" },
      { status: "DRAFT" },
      { externalId: "cbxdoc:102" },
    ]) {
      m.state.selects.push([sent])
      const r = await hook(
        completed(),
        fakeClient({ getEnvelope: completeEnvelope(over) }),
      )
      expect(r.outcome).toBe("unconfirmed")
    }
    m.state.selects.push([sent])
    const gone = await hook(
      completed(),
      fakeClient({
        getEnvelope: vi.fn(async () => ({
          ok: false as const,
          status: 404,
          error: "http-404",
        })),
      }),
    )
    expect(gone.outcome).toBe("unconfirmed")
    expect(m.attach).not.toHaveBeenCalled()
    expect(m.putObject).not.toHaveBeenCalled()
  })

  test("transient failures answer retry and never mark the row", async () => {
    const cases: Partial<DocumensoClient>[] = [
      {
        getEnvelope: vi.fn(async () => ({
          ok: false as const,
          status: null,
          error: "timeout",
        })),
      },
      { getEnvelope: completeEnvelope({ envelopeItems: [] }) },
      {
        getEnvelope: completeEnvelope(),
        downloadSignedItem: vi.fn(async () => ({
          ok: false as const,
          status: 500,
          error: "http-500",
        })),
      },
    ]
    for (const over of cases) {
      m.state.selects.push([sent])
      expect((await hook(completed(), fakeClient(over))).outcome).toBe("retry")
    }
    m.state.selects.push([sent])
    m.putObject.mockRejectedValueOnce(new Error("s3 down"))
    expect(
      (await hook(completed(), fakeClient({ getEnvelope: completeEnvelope() })))
        .outcome,
    ).toBe("retry")
    expect(m.state.sets).toEqual([])
    expect(m.attach).not.toHaveBeenCalled()
  })

  test("confirmed: stores the signed PDF, claims the row once, tags doc-signed emitting for all", async () => {
    m.state.selects.push([sent])
    m.state.updates.push([{ id: "101" }])
    const r = await hook(
      completed(),
      fakeClient({ getEnvelope: completeEnvelope() }),
    )
    expect(r).toEqual({ outcome: "signed", detail: "document 101" })
    expect(m.putObject).toHaveBeenCalledWith(
      "workspaces/w1/documents/c1/101.signed.pdf",
      Buffer.from(PDF),
      { ContentType: "application/pdf" },
    )
    expect(m.state.sets[0]).toMatchObject({
      status: "signed",
      signedPath: "workspaces/w1/documents/c1/101.signed.pdf",
    })
    expect(m.attach).toHaveBeenCalledWith({
      workspaceId: "w1",
      contactIds: ["c1"],
      names: [DOCUMENT_SIGNED_TAG],
      emitFor: "all",
    })
  })

  test("Documenso still PENDING right after the event = retry (it may not have committed yet)", async () => {
    m.state.selects.push([sent])
    const r = await hook(
      completed(),
      fakeClient({ getEnvelope: completeEnvelope({ status: "PENDING" }) }),
    )
    expect(r.outcome).toBe("retry")
    expect(m.putObject).not.toHaveBeenCalled()
  })

  test("a row whose Documenso id was never recorded still confirms through the envelope", async () => {
    m.state.selects.push([{ ...sent, documensoDocumentId: null }])
    m.state.updates.push([{ id: "101" }])
    const r = await hook(
      completed(),
      fakeClient({ getEnvelope: completeEnvelope() }),
    )
    expect(r.outcome).toBe("signed")
  })

  test("a payload without a numeric id still confirms through the envelope", async () => {
    m.state.selects.push([sent])
    m.state.updates.push([{ id: "101" }])
    const r = await hook(
      completed({ id: "document_42" }),
      fakeClient({ getEnvelope: completeEnvelope() }),
    )
    expect(r.outcome).toBe("signed")
  })

  test("losing the row claim to a concurrent delivery = duplicate, no second tag", async () => {
    m.state.selects.push([sent])
    m.state.updates.push([])
    const r = await hook(
      completed(),
      fakeClient({ getEnvelope: completeEnvelope() }),
    )
    expect(r.outcome).toBe("duplicate")
    expect(m.attach).not.toHaveBeenCalled()
  })

  test("a failed tag undoes the claim so the redelivery tags the contact", async () => {
    m.state.selects.push([sent])
    m.state.updates.push([{ id: "101" }], [])
    m.attach.mockRejectedValueOnce(new Error("db gone"))
    const r = await hook(
      completed(),
      fakeClient({ getEnvelope: completeEnvelope() }),
    )
    expect(r).toEqual({ outcome: "retry", detail: "tag: db gone" })
    expect(m.state.sets[1]).toEqual({
      status: "sent",
      signedPath: null,
      signedAt: null,
      updatedAt: expect.any(Date),
    })
  })

  test("no client configured = retry, not a silent drop", async () => {
    m.state.selects.push([sent])
    const r = await svc.completeFromWebhook({ body: completed() })
    expect(r).toEqual({ outcome: "retry", detail: "not-configured" })
  })
})

describe("verifyDocumensoSecret", () => {
  const SECRET = "0123456789abcdef0123"
  test("fails closed without a configured secret", () => {
    expect(verifyDocumensoSecret(SECRET, undefined)).toBe("not-configured")
    expect(verifyDocumensoSecret(SECRET, "")).toBe("not-configured")
  })
  test("constant-time match; missing, empty, prefix and longer headers are invalid", () => {
    expect(verifyDocumensoSecret(SECRET, SECRET)).toBe("ok")
    for (const h of [null, "", SECRET.slice(0, -1), `${SECRET}x`, "x"]) {
      expect(verifyDocumensoSecret(h, SECRET)).toBe("invalid")
    }
  })
})

test("signed copy lives beside the original, never under public/", () => {
  expect(signedDocumentPath("w1", "c1", "101")).toBe(
    "workspaces/w1/documents/c1/101.signed.pdf",
  )
})
