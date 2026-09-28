import http from "node:http"
import https from "node:https"
import type { LookupFunction } from "node:net"
import type { Readable } from "node:stream"
import zlib from "node:zlib"
import { isBlockedIp } from "../net/ssrf-guard"
import {
  hostOf,
  isIpLiteral,
  type Resolver,
  guardedLookup as sharedGuardedLookup,
} from "../net-node/guarded-lookup"

// Node only (this subpath already needs @napi-rs/canvas). The connection-bound
// check lives in net-node/guarded-lookup (shared with pinnedFetch since s216).
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
    | "unreachable"
  readonly detail: string

  constructor(reason: ImageFetchRefusedError["reason"], detail: string) {
    super(`[image-fetch] ${reason}: ${detail}`)
    this.name = "ImageFetchRefusedError"
    this.reason = reason
    this.detail = detail
  }
}

/** The shared guarded lookup, refusing with this module's error type. */
export const guardedLookup = (
  resolver?: Resolver,
  isBlocked: (ip: string) => boolean = isBlockedIp,
): LookupFunction =>
  sharedGuardedLookup(
    resolver,
    isBlocked,
    (hostname) => new ImageFetchRefusedError("unsafeAddress", hostname),
  )

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
  timeoutMs?: number
}

const getOnce = (
  url: URL,
  lookup: LookupFunction,
  maxBytes: number,
  signal: AbortSignal,
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
        signal,
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
 * lookup validated, redirects are followed by hand (at most 5), the body is
 * capped at 10 MB and the whole chain at 15 s. Throws `ImageFetchRefusedError` on any refusal.
 */
export const fetchImageBytes = async (
  rawUrl: string,
  options: Options = {},
): Promise<Buffer> => {
  const isBlocked = options.isBlocked ?? isBlockedIp
  const lookup = guardedLookup(options.resolver, isBlocked)
  const maxBytes = options.maxBytes ?? MAX_IMAGE_BYTES
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS
  // One deadline for the whole chain, not per hop: five slow redirects must
  // not hold a render for six timeouts (s215 skeptic).
  const signal = AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS)

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
    const { status, location, body } = await getOnce(
      url,
      lookup,
      maxBytes,
      signal,
    ).catch((error: unknown) => {
      // DNS failure, refused connection, reset or the chain deadline: the
      // URL cannot be loaded, which is the caller's input, not a crash.
      if (error instanceof ImageFetchRefusedError) {
        throw error
      }
      // The URL only: raw resolver/socket text never reaches the API client.
      throw new ImageFetchRefusedError("unreachable", url.href)
    })
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
