/**
 * Unguessable URL tokens in base62 (URL-safe, no escaping, no look-alike
 * separators). Web Crypto, not `node:crypto`, so Edge-Runtime code can mint
 * them. Never use `createId()` for a secret: a snowflake is sequential.
 */
const BASE62_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

const webRandomBytes = (n: number): Uint8Array =>
  globalThis.crypto.getRandomValues(new Uint8Array(n))

/** `byteLength` random bytes rendered as exactly `tokenLength` base62 characters. */
export const mintBase62Token = (
  byteLength: number,
  tokenLength: number,
  random: (bytes: number) => Uint8Array = webRandomBytes,
): string => {
  let value = 0n
  for (const byte of random(byteLength)) {
    value = value * 256n + BigInt(byte)
  }
  let out = ""
  for (let i = 0; i < tokenLength; i++) {
    out = BASE62_ALPHABET[Number(value % 62n)] + out
    value /= 62n
  }
  return out
}

/** True for a string of exactly `tokenLength` base62 characters. */
export const isBase62Token = (
  value: unknown,
  tokenLength: number,
): value is string =>
  typeof value === "string" &&
  value.length === tokenLength &&
  [...value].every((ch) => BASE62_ALPHABET.includes(ch))
