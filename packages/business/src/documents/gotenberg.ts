import { documentsEnv } from "./keys"

/**
 * HTML -> PDF through Gotenberg's Chromium route. Never throws for a service
 * failure: every failure is `{ ok: false, error }` (the bulktext s197c client,
 * ported). Output is capped while streaming and must carry both the `%PDF-`
 * header and the `%%EOF` trailer.
 */
export const MAX_DOCUMENT_PDF_BYTES = 5 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 15_000

export type PdfResult =
  | { ok: true; pdf: Uint8Array; ms: number }
  | { ok: false; status: number | null; error: string }

const readCapped = async (
  res: Response,
  max: number,
): Promise<Uint8Array | null> => {
  const reader = res.body?.getReader()
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer())
    return buf.length > max ? null : buf
  }
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    total += value.length
    if (total > max) {
      // Over the cap: stop reading; the answer is already too-large.
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

const latin1 = (bytes: Uint8Array): string =>
  String.fromCharCode(...Array.from(bytes))

export const isPdf = (pdf: Uint8Array): boolean =>
  latin1(pdf.subarray(0, 5)) === "%PDF-" &&
  latin1(pdf.subarray(Math.max(0, pdf.length - 1024))).includes("%%EOF")

export const htmlToPdf = async (
  html: string,
  opts: {
    baseUrl?: string
    fetchImpl?: typeof fetch
    timeoutMs?: number
  } = {},
): Promise<PdfResult> => {
  const baseUrl = opts.baseUrl ?? documentsEnv().GOTENBERG_URL
  if (!baseUrl) {
    return { ok: false, status: null, error: "not-configured" }
  }
  const fetchImpl = opts.fetchImpl ?? fetch
  const form = new FormData()
  // The Chromium route's entry file MUST be named index.html.
  form.append("files", new Blob([html], { type: "text/html" }), "index.html")
  const started = Date.now()
  try {
    const res = await fetchImpl(
      `${new URL(baseUrl).origin}/forms/chromium/convert/html`,
      {
        method: "POST",
        body: form,
        redirect: "manual",
        signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      },
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
    return { ok: true, pdf, ms: Date.now() - started }
  } catch (err) {
    const e = err as { name?: string; cause?: { code?: string }; message?: string }
    if (e?.name === "TimeoutError" || e?.name === "AbortError") {
      return { ok: false, status: null, error: "timeout" }
    }
    return { ok: false, status: null, error: `network: ${e?.cause?.code ?? e?.message ?? "unknown"}` }
  }
}
