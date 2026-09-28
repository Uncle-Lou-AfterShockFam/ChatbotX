import { lookup as dnsLookup, type LookupAddress } from "node:dns"
import http from "node:http"
import https from "node:https"
import type { LookupFunction } from "node:net"
import type { Readable } from "node:stream"
import zlib from "node:zlib"
import { isBlockedIp } from "../net/ssrf-guard"

// Node only (this subpath already needs @napi-rs/canvas), so the check can be
// bound to the connection: a `lookup` hook validates every address the
// system resolver returns and the socket connects to one of THOSE addresses.
// A separate check-then-fetch (DoH, then fetch's own resolver) can be steered
// by a name that answers differently each time (s215 Codex).
const MAX_REDIRECTS = 5
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const TIMEOUT_MS = 15_000

export class ImageFetchRefusedError extends Error {
  readonly reason:
    | "unsafeUrl"
    | "unsafeAddress"
    | "unsafeRedirect"
    | "tooManyRedirects"
    | "tooLarge"
    | "httpError"
    | "unsupportedEncoding"

  constructor(reason: ImageFetchRefusedError["reason"], detail: string) {
    super(`[image-fetch] ${reason}: ${detail}`)
    this.name = "ImageFetchRefusedError"
    this.reason = reason
  }
}

type Resolver = (hostname: string) => Promise<LookupAddress[]>

const systemResolver: Resolver = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) =>
      error ? reject(error) : resolve(addresses),
    )
  })

/**
 * A `net` lookup that refuses the whole name when ANY address it resolves to
 * is blocked (so neither address family can be used to slip past), and
 * otherwise hands the socket exactly the validated addresses.
 */
export const guardedLookup =
  (
    resolver: Resolver = systemResolver,
    isBlocked = isBlockedIp,
  ): LookupFunction =>
  (hostname, options, callback) => {
    resolver(hostname).then(
      (addresses) => {
        if (
          addresses.length === 0 ||
          addresses.some((entry) => isBlocked(entry.address))
        ) {
          callback(new ImageFetchRefusedError("unsafeAddress", hostname), "", 0)
          return
        }
        if ((options as { all?: boolean }).all) {
          ;(callback as unknown as (e: null, a: LookupAddress[]) => void)(
            null,
            addresses,
          )
          return
        }
        callback(null, addresses[0]?.address ?? "", addresses[0]?.family ?? 4)
      },
      (error: Error) => callback(error as NodeJS.ErrnoException, "", 0),
    )
  }

const hostOf = (url: URL) => url.hostname.replace(/^\[|\]$/g, "")

const isIpLiteral = (host: string) =>
  /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")

const DECODERS: Record<
  string,
  "identity" | (() => zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress)
> = {
  identity: "identity",
  gzip: () => zlib.createGunzip(),
  "x-gzip": () => zlib.createGunzip(),
  deflate: () => zlib.createInflate(),
  br: () => zlib.createBrotliDecompress(),
}

type Options = {
  resolver?: Resolver
  isBlocked?: (ip: string) => boolean
  maxBytes?: number
  maxRedirects?: number
}

const getOnce = (
  url: URL,
  lookup: LookupFunction,
  maxBytes: number,
): Promise<{ status: number; location: string | null; body: Buffer }> =>
  new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http
    const request = client.get(
      url,
      {
        lookup,
        // No pooled keep-alive socket: every request dials, so every
        // connection goes through `lookup` (a reused socket would skip it).
        agent: false,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
      (response) => {
        const status = response.statusCode ?? 0
        if (status >= 300 && status < 400) {
          response.resume()
          resolve({
            status,
            location: response.headers.location ?? null,
            body: Buffer.alloc(0),
          })
          return
        }
        // What fetch did for free: a precompressed object (Content-Encoding)
        // is decoded, and the cap counts DECODED bytes (a zip bomb stops at
        // the cap, not at the wire size).
        const encoding = (response.headers["content-encoding"] ?? "identity")
          .trim()
          .toLowerCase()
        const decoder = DECODERS[encoding]
        if (!decoder) {
          response.resume()
          reject(new ImageFetchRefusedError("unsupportedEncoding", encoding))
          return
        }
        const body: Readable =
          decoder === "identity" ? response : response.pipe(decoder())
        const chunks: Buffer[] = []
        let size = 0
        let tooLarge = false
        body.on("data", (chunk: Buffer) => {
          size += chunk.length
          if (size > maxBytes) {
            tooLarge = true
            reject(new ImageFetchRefusedError("tooLarge", url.href))
            request.destroy()
            body.destroy()
            return
          }
          chunks.push(chunk)
        })
        body.on("end", () => {
          if (!tooLarge) {
            resolve({ status, location: null, body: Buffer.concat(chunks) })
          }
        })
        body.on("error", reject)
        response.on("error", reject)
      },
    )
    request.on("error", reject)
  })

/**
 * The bytes of a remote image. Every hop is http(s), an IP-literal host is
 * checked directly, a named host connects only to addresses the guarded
 * lookup validated, redirects are followed by hand (at most 5), and the body
 * is capped at 10 MB. Throws `ImageFetchRefusedError` on any refusal.
 */
export const fetchImageBytes = async (
  rawUrl: string,
  options: Options = {},
): Promise<Buffer> => {
  const isBlocked = options.isBlocked ?? isBlockedIp
  const lookup = guardedLookup(options.resolver, isBlocked)
  const maxBytes = options.maxBytes ?? MAX_IMAGE_BYTES
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS

  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new ImageFetchRefusedError("unsafeUrl", rawUrl)
  }
  for (let hop = 0; ; hop += 1) {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new ImageFetchRefusedError(
        hop === 0 ? "unsafeUrl" : "unsafeRedirect",
        url.href,
      )
    }
    const host = hostOf(url)
    if (isIpLiteral(host) && isBlocked(host)) {
      throw new ImageFetchRefusedError(
        hop === 0 ? "unsafeUrl" : "unsafeRedirect",
        url.href,
      )
    }
    const { status, location, body } = await getOnce(url, lookup, maxBytes)
    if (status < 300 || status >= 400) {
      if (status < 200 || status >= 300) {
        throw new ImageFetchRefusedError("httpError", `${status} ${url.href}`)
      }
      return body
    }
    if (hop >= maxRedirects) {
      throw new ImageFetchRefusedError("tooManyRedirects", url.href)
    }
    if (!location) {
      throw new ImageFetchRefusedError("unsafeRedirect", url.href)
    }
    try {
      url = new URL(location, url)
    } catch {
      throw new ImageFetchRefusedError("unsafeRedirect", location)
    }
  }
}
