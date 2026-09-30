const BLOCKED_HOSTNAMES = new Set(["localhost", "localhost.localdomain"])

const DOH_ENDPOINT = "https://1.1.1.1/dns-query"
const DOH_TIMEOUT_MS = 3000
const DNS_RECORD_TYPE_A = 1
const DNS_RECORD_TYPE_AAAA = 28

const BLOCKED_IPV4_RANGES: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]

const IPV4_PATTERN =
  /^(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)){3}$/

const isIpv4Literal = (value: string): boolean => IPV4_PATTERN.test(value)

const isIpv6Literal = (value: string): boolean => {
  if (!value.includes(":")) {
    return false
  }
  try {
    // The URL/Web API host parser normalizes and validates IPv6 literals.
    new URL(`http://[${value.replace(/^\[|\]$/g, "")}]`)
    return true
  } catch {
    return false
  }
}

const ipv4ToInt = (ip: string): number =>
  ip
    .split(".")
    .reduce((acc, octet) => acc * 256 + Number.parseInt(octet, 10), 0)

const isIpv4InRange = (ip: string, range: string, prefixLength: number) => {
  const hostBits = 32 - prefixLength
  const blockSize = 2 ** hostBits
  const networkStart = Math.floor(ipv4ToInt(range) / blockSize) * blockSize
  const networkEnd = networkStart + blockSize
  const ipValue = ipv4ToInt(ip)
  return ipValue >= networkStart && ipValue < networkEnd
}

const isBlockedIpv4 = (ip: string): boolean =>
  BLOCKED_IPV4_RANGES.some(([range, prefixLength]) =>
    isIpv4InRange(ip, range, prefixLength),
  )

// IPv6 is judged on its 128-bit value, never on its text: one address has
// many spellings (zero-padded groups, "::" anywhere, a dotted IPv4 tail,
// uppercase), and a prefix test on one spelling misses the others.
const IPV6_GROUPS = 8

/** The address as a 128-bit integer; null when it is not an IPv6 literal. */
const ipv6ToBigInt = (ip: string): bigint | null => {
  let canonical: string
  try {
    // WHATWG host parsing canonicalizes: lowercase, compressed, a dotted
    // IPv4 tail rewritten as two hex groups. It refuses zone ids ("%eth0").
    canonical = new URL(`http://[${ip}]`).hostname.slice(1, -1)
  } catch {
    return null
  }
  const [head = "", tail] = canonical.split("::")
  const headGroups = head === "" ? [] : head.split(":")
  const tailGroups = tail === undefined || tail === "" ? [] : tail.split(":")
  const groups =
    tail === undefined
      ? headGroups
      : [
          ...headGroups,
          ...Array.from(
            { length: IPV6_GROUPS - headGroups.length - tailGroups.length },
            () => "0",
          ),
          ...tailGroups,
        ]
  if (groups.length !== IPV6_GROUPS) {
    return null
  }
  return groups.reduce(
    (acc, group) => acc * 0x1_00_00n + BigInt(Number.parseInt(group, 16)),
    0n,
  )
}

const ipv6Cidr = (range: string, prefixLength: number) => {
  const base = ipv6ToBigInt(range)
  if (base === null) {
    throw new Error(`Invalid IPv6 range ${range}`)
  }
  const hostSize = 2n ** BigInt(128 - prefixLength)
  return (value: bigint) => value / hostSize === base / hostSize
}

// Never a public unicast destination (IANA special-purpose registry).
const BLOCKED_IPV6_RANGES = [
  ipv6Cidr("::", 96), // unspecified, loopback, deprecated IPv4-compatible
  ipv6Cidr("64:ff9b:1::", 48), // local-use NAT64
  ipv6Cidr("100::", 64), // discard-only
  ipv6Cidr("2001::", 23), // IETF protocol assignments (Teredo, ORCHID, ...)
  ipv6Cidr("2001:db8::", 32), // documentation
  ipv6Cidr("3fff::", 20), // documentation
  ipv6Cidr("5f00::", 16), // SRv6 SIDs
  ipv6Cidr("fc00::", 7), // unique local
  ipv6Cidr("fe80::", 10), // link-local
  ipv6Cidr("fec0::", 10), // deprecated site-local
  ipv6Cidr("ff00::", 8), // multicast
]

const intToIpv4 = (value: bigint): string =>
  [3n, 2n, 1n, 0n]
    .map((octet) => Number((value / 256n ** octet) % 256n))
    .join(".")

// Forms that carry an IPv4 address: judged by that address, so a public one
// passes and a private one is blocked. [range, where the IPv4 sits]
const EMBEDDED_IPV4_RANGES: [(value: bigint) => boolean, bigint][] = [
  [ipv6Cidr("::ffff:0:0", 96), 0n], // IPv4-mapped
  [ipv6Cidr("::ffff:0:0:0", 96), 0n], // IPv4-translated
  [ipv6Cidr("64:ff9b::", 96), 0n], // NAT64
  [ipv6Cidr("2002::", 16), 80n], // 6to4: bits 16-47
]

const isBlockedIpv6 = (ip: string): boolean => {
  const value = ipv6ToBigInt(ip)
  if (value === null) {
    return true
  }
  for (const [inRange, shift] of EMBEDDED_IPV4_RANGES) {
    if (inRange(value)) {
      return isBlockedIpv4(intToIpv4((value / 2n ** shift) % 2n ** 32n))
    }
  }
  return BLOCKED_IPV6_RANGES.some((inRange) => inRange(value))
}

/**
 * True for any address an outbound request must not reach (private, loopback,
 * link-local, reserved, mapped/NAT64 forms of those) and for anything that is
 * not an IP literal at all (fail closed).
 */
export const isBlockedIp = (ip: string): boolean => {
  if (isIpv4Literal(ip)) {
    return isBlockedIpv4(ip)
  }
  if (isIpv6Literal(ip)) {
    return isBlockedIpv6(ip)
  }
  return true
}

type DohAnswer = { type: number; data: string }
type DohResponse = { Answer?: DohAnswer[] }

const resolveRecords = async (
  hostname: string,
  type: "A" | "AAAA",
): Promise<string[]> => {
  const url = new URL(DOH_ENDPOINT)
  url.searchParams.set("name", hostname)
  url.searchParams.set("type", type)

  const response = await fetch(url, {
    headers: { accept: "application/dns-json" },
    signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
  })

  if (!response.ok) {
    throw new Error(`DoH lookup failed with status ${response.status}`)
  }

  const body = (await response.json()) as DohResponse
  return (body.Answer ?? [])
    .filter(
      (answer) =>
        answer.type === DNS_RECORD_TYPE_A ||
        answer.type === DNS_RECORD_TYPE_AAAA,
    )
    .map((answer) => answer.data)
}

// A and AAAA both (s215): a name with a public A and a private AAAA passed an
// A-only check, and a dual-stack client may connect over either.
const resolveHostname = async (hostname: string): Promise<string[]> =>
  (
    await Promise.all([
      resolveRecords(hostname, "A"),
      resolveRecords(hostname, "AAAA"),
    ])
  ).flat()

export type SsrfCheckResult =
  | { unsafe: true }
  | { unsafe: false; resolvedIps: string[] }

export const checkSsrfSafety = async (
  rawUrl: string,
): Promise<SsrfCheckResult> => {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return { unsafe: true }
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { unsafe: true }
  }

  // URL.hostname keeps IPv6 literals bracketed (e.g. "[::1]"); strip the
  // brackets so downstream IP checks see the bare address consistently.
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return { unsafe: true }
  }

  if (isIpv4Literal(hostname) || isIpv6Literal(hostname)) {
    return isBlockedIp(hostname)
      ? { unsafe: true }
      : { unsafe: false, resolvedIps: [hostname] }
  }

  try {
    const resolvedIps = await resolveHostname(hostname)
    if (resolvedIps.length === 0) {
      return { unsafe: true }
    }
    if (resolvedIps.some((ip) => isBlockedIp(ip))) {
      return { unsafe: true }
    }
    return { unsafe: false, resolvedIps }
  } catch {
    return { unsafe: true }
  }
}

export const isSsrfUnsafeUrl = async (rawUrl: string): Promise<boolean> =>
  (await checkSsrfSafety(rawUrl)).unsafe

/**
 * Throws when `rawUrl` resolves to a private/loopback/link-local address or
 * fails DNS resolution — the shared guard for any code path that makes an
 * outbound request to a user- or workspace-supplied URL.
 */
export const assertPublicUrl = async (
  rawUrl: string,
  context = "URL",
): Promise<void> => {
  const result = await checkSsrfSafety(rawUrl)
  if (result.unsafe) {
    throw new Error(`[ssrf-guard] ${context} is not allowed: ${rawUrl}`)
  }
}
