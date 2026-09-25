import { describe, expect, test } from "vitest"
import {
  htmlToPdf,
  isPdf,
  MAX_DOCUMENT_PDF_BYTES,
} from "../src/documents/gotenberg"

const PDF = new TextEncoder().encode("%PDF-1.4\n...\n%%EOF\n")
const pdfRes = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Response(body, {
    status: 200,
    headers: { "content-type": "application/pdf", ...headers },
  })

describe("gotenberg htmlToPdf", () => {
  test("posts index.html to the chromium route of the configured origin, no redirects", async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const r = await htmlToPdf("<p>hi</p>", {
      baseUrl: "http://gotenberg:3000/ignored",
      fetchImpl: ((url: string, init: RequestInit) => {
        calls.push({ url, init })
        return Promise.resolve(pdfRes(PDF))
      }) as typeof fetch,
    })
    expect(r.ok).toBe(true)
    expect(calls[0].url).toBe(
      "http://gotenberg:3000/forms/chromium/convert/html",
    )
    expect(calls[0].init.redirect).toBe("manual")
    const file = (calls[0].init.body as FormData).get("files") as File
    expect(file.name).toBe("index.html")
    expect(await file.text()).toBe("<p>hi</p>")
  })

  test("failures are values: unconfigured, http, not a PDF, header without trailer, too large, network, timeout", async () => {
    const run = (
      respond: () => Response | Promise<Response>,
      timeoutMs?: number,
    ) =>
      htmlToPdf("x", {
        baseUrl: "http://g:3000",
        fetchImpl: (async () => await respond()) as typeof fetch,
        timeoutMs,
      })
    expect(await htmlToPdf("x", { baseUrl: "" })).toEqual({
      ok: false,
      status: null,
      error: "not-configured",
    })
    expect(await run(() => new Response("boom", { status: 500 }))).toEqual({
      ok: false,
      status: 500,
      error: "http-500",
    })
    expect(await run(() => pdfRes("<html>"))).toEqual({
      ok: false,
      status: 200,
      error: "not-pdf",
    })
    expect(await run(() => pdfRes("%PDF-garbage"))).toEqual({
      ok: false,
      status: 200,
      error: "not-pdf",
    })
    let pulled = 0
    const endless = new ReadableStream({
      pull(c) {
        pulled++
        c.enqueue(new Uint8Array(1024 * 1024))
      },
    })
    expect(await run(() => pdfRes(endless))).toEqual({
      ok: false,
      status: 200,
      error: "too-large",
    })
    expect(pulled).toBeLessThanOrEqual(
      Math.ceil(MAX_DOCUMENT_PDF_BYTES / (1024 * 1024)) + 2,
    )
    expect(
      await run(() => {
        throw Object.assign(new Error("x"), { cause: { code: "ECONNREFUSED" } })
      }),
    ).toEqual({
      ok: false,
      status: null,
      error: "network: ECONNREFUSED",
    })
    const hang = () =>
      new Promise<Response>((_r, reject) =>
        setTimeout(
          () => reject(Object.assign(new Error("t"), { name: "TimeoutError" })),
          5,
        ),
      )
    expect(await run(hang, 1)).toEqual({
      ok: false,
      status: null,
      error: "timeout",
    })
  })

  test("isPdf needs the header and a trailer near the end", () => {
    expect(isPdf(PDF)).toBe(true)
    expect(isPdf(new TextEncoder().encode("%PDF-"))).toBe(false)
    expect(isPdf(new Uint8Array(0))).toBe(false)
  })
})
