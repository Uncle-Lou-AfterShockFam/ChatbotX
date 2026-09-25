import { describe, expect, test } from "vitest"
import { createDocumensoClient } from "../src/documents/documenso"
import { MAX_DOCUMENT_PDF_BYTES } from "../src/documents/gotenberg"

const PDF = new TextEncoder().encode("%PDF-1.4\n...\n%%EOF\n")
const ENVELOPE = "envelope_abcdefgh12"

type Call = { url: string; init: RequestInit }
const client = (respond: (call: Call) => Response | Promise<Response>) => {
  const calls: Call[] = []
  const c = createDocumensoClient({
    baseUrl: "http://documenso:3000/ignored/path",
    apiToken: "api_testtoken",
    fetchImpl: (async (url: string, init: RequestInit) => {
      const call = { url, init }
      calls.push(call)
      return await respond(call)
    }) as typeof fetch,
  })
  return { c, calls }
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

describe("documenso client", () => {
  test("createEnvelope posts multipart payload + PDF to the configured origin with the raw token, no redirects", async () => {
    const { c, calls } = client(() => json({ id: ENVELOPE }))
    const r = await c.createEnvelope({
      pdf: PDF,
      title: "Consent",
      externalId: "cbxdoc:1",
      recipient: { email: "sig+1@example.org", name: "Ada" },
    })
    expect(r).toEqual({ ok: true, status: 200, envelopeId: ENVELOPE })
    expect(calls[0].url).toBe("http://documenso:3000/api/v2/envelope/create")
    expect(calls[0].init.redirect).toBe("manual")
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers.Authorization).toBe("api_testtoken")
    const form = calls[0].init.body as FormData
    const payload = JSON.parse(String(form.get("payload")))
    expect(payload).toEqual({
      type: "DOCUMENT",
      title: "Consent",
      externalId: "cbxdoc:1",
      recipients: [{ email: "sig+1@example.org", name: "Ada", role: "SIGNER" }],
      meta: { distributionMethod: "NONE" },
    })
    const file = form.get("files") as File
    expect(file.name).toBe("document.pdf")
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(PDF)
  })

  test("createEnvelope refuses an answer without a well-formed envelope id", async () => {
    for (const body of [{}, { id: 7 }, { id: "doc_1" }, [ENVELOPE], null]) {
      const { c } = client(() => json(body))
      const r = await c.createEnvelope({
        pdf: PDF,
        title: "t",
        externalId: "cbxdoc:1",
        recipient: { email: "a@b.co", name: "x" },
      })
      expect(r).toEqual({ ok: false, status: 200, error: "bad-json" })
    }
  })

  test("failures are values: http, non-JSON, network, timeout", async () => {
    expect(
      await client(() => new Response("no", { status: 401 })).c.getEnvelope(
        ENVELOPE,
      ),
    ).toEqual({ ok: false, status: 401, error: "http-401" })
    expect(
      await client(() => new Response("<html>")).c.getEnvelope(ENVELOPE),
    ).toEqual({ ok: false, status: 200, error: "bad-json" })
    const net = await client(() => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: { code: "ECONNREFUSED" },
      })
    }).c.distributeEnvelope(ENVELOPE)
    expect(net).toEqual({
      ok: false,
      status: null,
      error: "network: ECONNREFUSED",
    })
    const timeout = await client(() => {
      throw Object.assign(new Error("t"), { name: "TimeoutError" })
    }).c.getEnvelope(ENVELOPE)
    expect(timeout).toEqual({ ok: false, status: null, error: "timeout" })
  })

  test("envelope and item ids are checked before any request (no path injection)", async () => {
    const { c, calls } = client(() => json({}))
    for (const bad of ["", "envelope_", "../envelope_abcdefgh", "x"]) {
      expect((await c.getEnvelope(bad)).ok).toBe(false)
      expect((await c.distributeEnvelope(bad)).ok).toBe(false)
    }
    for (const bad of ["", "a/b", "../x", "a?b"]) {
      expect(await c.downloadSignedItem(bad)).toEqual({
        ok: false,
        status: null,
        error: "bad-item-id",
      })
    }
    expect(calls).toHaveLength(0)
  })

  test("distributeEnvelope sends NONE and returns the body", async () => {
    const { c, calls } = client(() =>
      json({ recipients: [{ email: "a@b.co", signingUrl: "https://s/x" }] }),
    )
    const r = await c.distributeEnvelope(ENVELOPE)
    expect(r.ok).toBe(true)
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      envelopeId: ENVELOPE,
      meta: { distributionMethod: "NONE" },
    })
    expect(calls[0].url).toBe(
      "http://documenso:3000/api/v2/envelope/distribute",
    )
  })

  test("downloadSignedItem: the signed version, capped, must be a PDF", async () => {
    const ok = client(() => new Response(PDF))
    expect(await ok.c.downloadSignedItem("item_1")).toEqual({
      ok: true,
      status: 200,
      pdf: PDF,
    })
    expect(ok.calls[0].url).toBe(
      "http://documenso:3000/api/v2/envelope/item/item_1/download?version=signed",
    )
    expect(
      await client(() => new Response("<html>")).c.downloadSignedItem("i"),
    ).toEqual({ ok: false, status: 200, error: "not-pdf" })
    const big = new Uint8Array(MAX_DOCUMENT_PDF_BYTES + 1)
    expect(
      await client(() => new Response(big)).c.downloadSignedItem("i"),
    ).toEqual({ ok: false, status: 200, error: "too-large" })
    expect(
      await client(
        () => new Response("x", { status: 404 }),
      ).c.downloadSignedItem("i"),
    ).toEqual({ ok: false, status: 404, error: "http-404" })
  })
})

describe("documenso client bounds", () => {
  test("a JSON answer over 256 KB is refused while streaming, never buffered whole", async () => {
    let pulled = 0
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 64 * 1024
        controller.enqueue(new Uint8Array(64 * 1024).fill(32))
      },
    })
    const r = await client(() => new Response(endless)).c.getEnvelope(ENVELOPE)
    expect(r).toEqual({ ok: false, status: 200, error: "too-large" })
    expect(pulled).toBeLessThan(1024 * 1024)
  })

  test("a non-ok answer's body is cancelled, not read", async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024))
      },
      cancel() {
        cancelled = true
      },
    })
    const r = await client(
      () => new Response(body, { status: 500 }),
    ).c.getEnvelope(ENVELOPE)
    expect(r).toEqual({ ok: false, status: 500, error: "http-500" })
    expect(cancelled).toBe(true)
  })

  test("deleteEnvelope posts the id; a bad id makes no request", async () => {
    const { c, calls } = client(() => json({ success: true }))
    expect((await c.deleteEnvelope(ENVELOPE)).ok).toBe(true)
    expect(calls[0].url).toBe("http://documenso:3000/api/v2/envelope/delete")
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      envelopeId: ENVELOPE,
    })
    expect((await c.deleteEnvelope("../x")).ok).toBe(false)
    expect(calls).toHaveLength(1)
  })
})

describe("documensoConfigFromEnv", () => {
  test("empty env values (the compose empty-default) read as not configured", async () => {
    const { documensoConfigFromEnv } = await import(
      "../src/documents/documenso"
    )
    const saved = { ...process.env }
    try {
      process.env.DOCUMENSO_URL = ""
      process.env.DOCUMENSO_API_TOKEN = ""
      expect(documensoConfigFromEnv()).toBeNull()
      process.env.DOCUMENSO_URL = "http://documenso:3000"
      expect(documensoConfigFromEnv()).toBeNull()
      process.env.DOCUMENSO_API_TOKEN = "api_testtoken"
      expect(documensoConfigFromEnv()).toEqual({
        baseUrl: "http://documenso:3000",
        apiToken: "api_testtoken",
      })
    } finally {
      process.env = saved
    }
  })
})
