import { isPdf, MAX_DOCUMENT_PDF_BYTES, readCapped } from "./gotenberg"
import { documentsEnv } from "./keys"

/**
 * Documenso API client for the signing step and webhook (roadmap B6 in the
 * hub; the bulktext s197c client, ported). Operator config only: the base URL
 * is never caller input (on netcup the docker-internal http://documenso:3000).
 * Auth is the raw `api_` token in Authorization, no Bearer. Never throws for a
 * service failure: every failure is `{ ok: false, status, error }`.
 *
 * Facts probed live (s197c): v2 `envelope/create` turns `{{signature, r1}}` /
 * `{{date, r1}}` text in the PDF into fields; `distribute` on a PENDING
 * envelope is idempotent (same signing token).
 */
const MAX_JSON_BYTES = 256 * 1024
const DEFAULT_TIMEOUT_MS = 10_000
export const ENVELOPE_ID_REGEX = /^envelope_[a-z0-9]{8,64}$/
const ITEM_ID_REGEX = /^[A-Za-z0-9_-]{1,100}$/

export type DocumensoFailure = {
  ok: false
  status: number | null
  error: string
}
export type DocumensoResult<T> =
  | ({ ok: true; status: number } & T)
  | DocumensoFailure

export type DocumensoConfig = {
  baseUrl: string
  apiToken: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

type JsonObject = Record<string, unknown>

const isObject = (v: unknown): v is JsonObject =>
  v !== null && typeof v === "object" && !Array.isArray(v)

const failure = (err: unknown): DocumensoFailure => {
  const e = err as {
    name?: string
    cause?: { code?: string }
    message?: string
  }
  if (e?.name === "TimeoutError" || e?.name === "AbortError") {
    return { ok: false, status: null, error: "timeout" }
  }
  return {
    ok: false,
    status: null,
    error: `network: ${e?.cause?.code ?? e?.message ?? "unknown"}`,
  }
}

/** The configured client, or null when any of URL / token is missing. */
export const documensoConfigFromEnv = (): DocumensoConfig | null => {
  const env = documentsEnv()
  if (!(env.DOCUMENSO_URL && env.DOCUMENSO_API_TOKEN)) {
    return null
  }
  return { baseUrl: env.DOCUMENSO_URL, apiToken: env.DOCUMENSO_API_TOKEN }
}

export const createDocumensoClient = (config: DocumensoConfig) => {
  const origin = new URL(config.baseUrl).origin
  const fetchImpl = config.fetchImpl ?? fetch
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const send = (
    method: "GET" | "POST",
    path: string,
    body?: string | FormData,
    contentType?: string,
  ) =>
    fetchImpl(`${origin}${path}`, {
      method,
      headers: {
        Authorization: config.apiToken,
        Accept: "application/json",
        ...(contentType ? { "Content-Type": contentType } : {}),
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    })

  const json = async (
    method: "GET" | "POST",
    path: string,
    body?: { json?: unknown; form?: FormData },
  ): Promise<DocumensoResult<{ body: JsonObject }>> => {
    try {
      const res = await (body?.form
        ? send(method, path, body.form)
        : send(
            method,
            path,
            body?.json === undefined ? undefined : JSON.stringify(body.json),
            body?.json === undefined ? undefined : "application/json",
          ))
      const text = (await res.text()).slice(0, MAX_JSON_BYTES)
      if (!res.ok) {
        return { ok: false, status: res.status, error: `http-${res.status}` }
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        return { ok: false, status: res.status, error: "bad-json" }
      }
      if (!isObject(parsed)) {
        return { ok: false, status: res.status, error: "bad-json" }
      }
      return { ok: true, status: res.status, body: parsed }
    } catch (err) {
      return failure(err)
    }
  }

  /** v2 envelope/create from one PDF: a DRAFT DOCUMENT with one SIGNER. */
  const createEnvelope = async (input: {
    pdf: Uint8Array
    title: string
    externalId: string
    recipient: { email: string; name: string }
  }): Promise<DocumensoResult<{ envelopeId: string }>> => {
    const form = new FormData()
    form.append(
      "payload",
      JSON.stringify({
        type: "DOCUMENT",
        title: input.title,
        externalId: input.externalId,
        recipients: [{ ...input.recipient, role: "SIGNER" }],
        // NONE: Documenso mails nobody; the link goes out over the contact's line.
        meta: { distributionMethod: "NONE" },
      }),
    )
    form.append(
      "files",
      new Blob([new Uint8Array(input.pdf)], { type: "application/pdf" }),
      "document.pdf",
    )
    const r = await json("POST", "/api/v2/envelope/create", { form })
    if (!r.ok) {
      return r
    }
    const id = r.body.id
    if (typeof id !== "string" || !ENVELOPE_ID_REGEX.test(id)) {
      return { ok: false, status: r.status, error: "bad-json" }
    }
    return { ok: true, status: r.status, envelopeId: id }
  }

  const getEnvelope = (envelopeId: string) => {
    if (!ENVELOPE_ID_REGEX.test(envelopeId)) {
      return Promise.resolve<DocumensoFailure>({
        ok: false,
        status: null,
        error: "bad-envelope-id",
      })
    }
    return json("GET", `/api/v2/envelope/${envelopeId}`)
  }

  /** DRAFT -> PENDING; the answer carries each recipient's signingUrl. */
  const distributeEnvelope = (envelopeId: string) => {
    if (!ENVELOPE_ID_REGEX.test(envelopeId)) {
      return Promise.resolve<DocumensoFailure>({
        ok: false,
        status: null,
        error: "bad-envelope-id",
      })
    }
    return json("POST", "/api/v2/envelope/distribute", {
      json: { envelopeId, meta: { distributionMethod: "NONE" } },
    })
  }

  /** The signed PDF of one envelope item, capped and checked to be a PDF. */
  const downloadSignedItem = async (
    itemId: string,
  ): Promise<DocumensoResult<{ pdf: Uint8Array }>> => {
    if (!ITEM_ID_REGEX.test(itemId)) {
      return { ok: false, status: null, error: "bad-item-id" }
    }
    try {
      const res = await send(
        "GET",
        `/api/v2/envelope/item/${itemId}/download?version=signed`,
      )
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined)
        return { ok: false, status: res.status, error: `http-${res.status}` }
      }
      const pdf = await readCapped(res, MAX_DOCUMENT_PDF_BYTES)
      if (pdf === null) {
        return { ok: false, status: res.status, error: "too-large" }
      }
      if (!isPdf(pdf)) {
        return { ok: false, status: res.status, error: "not-pdf" }
      }
      return { ok: true, status: res.status, pdf }
    } catch (err) {
      return failure(err)
    }
  }

  return { createEnvelope, getEnvelope, distributeEnvelope, downloadSignedItem }
}

export type DocumensoClient = ReturnType<typeof createDocumensoClient>
