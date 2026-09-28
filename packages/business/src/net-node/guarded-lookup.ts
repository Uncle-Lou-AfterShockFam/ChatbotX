import { lookup as dnsLookup, type LookupAddress } from "node:dns"
import type { LookupFunction } from "node:net"
import { isBlockedIp } from "../net/ssrf-guard"

// Node only. The SSRF check is bound to the connection: a `lookup` hook
// validates every address the system resolver returns and the socket connects
// to one of THOSE addresses. A separate check-then-fetch (DoH, then fetch's
// own resolver) can be steered by a name that answers differently each time
// (DNS rebinding; s215 Codex, s216 for the non-image callers).

export type Resolver = (hostname: string) => Promise<LookupAddress[]>

export const systemResolver: Resolver = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) =>
      error ? reject(error) : resolve(addresses),
    )
  })

/**
 * A `net` lookup that refuses the whole name when ANY address it resolves to
 * is blocked (so neither address family can be used to slip past), and
 * otherwise hands the socket exactly the validated addresses. `refuse` builds
 * the error the caller's own error type expects.
 */
export const guardedLookup =
  (
    resolver: Resolver = systemResolver,
    isBlocked: (ip: string) => boolean = isBlockedIp,
    refuse: (hostname: string) => Error = (hostname) =>
      new Error(`[ssrf-guard] unsafeAddress: ${hostname}`),
  ): LookupFunction =>
  (hostname, options, callback) => {
    resolver(hostname).then(
      (addresses) => {
        if (
          addresses.length === 0 ||
          addresses.some((entry) => isBlocked(entry.address))
        ) {
          callback(refuse(hostname) as NodeJS.ErrnoException, "", 0)
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

const IPV6_BRACKETS = /^\[|\]$/g
const DOTTED_IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

/** The URL's host without IPv6 brackets. */
export const hostOf = (url: URL) => url.hostname.replace(IPV6_BRACKETS, "")

/**
 * True for a host the socket connects to WITHOUT calling `lookup` (an IP
 * literal; the WHATWG parser has already normalised 2130706433 / 0x7f.1 to
 * dotted form), so the caller must check it directly.
 */
export const isIpLiteral = (host: string) =>
  DOTTED_IPV4.test(host) || host.includes(":")
