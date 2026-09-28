import { describe, expect, test } from "vitest"
import { signGuestSecret, verifyGuestSecret } from "../src/guest-secret"

const WS = "11701868563365888"
const OTHER_WS = "11701868563365889"
const UUID = "0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f"
const ID = `${WS}:${UUID}`
const KEY = "k".repeat(32)
const OTHER_KEY = "j".repeat(32)
const HEX64 = /^[0-9a-f]{64}$/

describe("signGuestSecret (s215)", () => {
  test("is a deterministic 64-hex HMAC of the id", async () => {
    const secret = await signGuestSecret(ID, KEY)
    expect(secret).toMatch(HEX64)
    expect(await signGuestSecret(ID, KEY)).toBe(secret)
  })

  test("differs per id, per workspace prefix and per key", async () => {
    const secret = await signGuestSecret(ID, KEY)
    expect(await signGuestSecret(`${WS}:${crypto.randomUUID()}`, KEY)).not.toBe(
      secret,
    )
    expect(await signGuestSecret(`${OTHER_WS}:${UUID}`, KEY)).not.toBe(secret)
    expect(await signGuestSecret(ID, OTHER_KEY)).not.toBe(secret)
  })

  test("is not the plain HMAC of the id under the broadcast secret", async () => {
    // The key is derived with a label, so a broadcast-token signer's output
    // over the same bytes is never a guest secret.
    const { hmacSha256Hex } = await import("@chatbotx.io/utils/crypto")
    expect(await signGuestSecret(ID, KEY)).not.toBe(
      await hmacSha256Hex(KEY, ID),
    )
  })

  test("refuses a non-minted id or a missing/short key", async () => {
    await expect(signGuestSecret("123456", KEY)).rejects.toThrow(TypeError)
    await expect(signGuestSecret("", KEY)).rejects.toThrow(TypeError)
    await expect(signGuestSecret(ID, "short")).rejects.toThrow(TypeError)
    await expect(
      signGuestSecret(ID, undefined as unknown as string),
    ).rejects.toThrow(TypeError)
  })
})

describe("verifyGuestSecret (s215)", () => {
  test("accepts the id's own secret, with or without the workspace", async () => {
    const secret = await signGuestSecret(ID, KEY)
    expect(await verifyGuestSecret(ID, secret, KEY)).toBe(true)
    expect(await verifyGuestSecret(ID, secret, KEY, WS)).toBe(true)
  })

  test("refuses another id's secret, a foreign workspace and another key", async () => {
    const secret = await signGuestSecret(ID, KEY)
    const otherId = `${WS}:${crypto.randomUUID()}`
    expect(await verifyGuestSecret(otherId, secret, KEY)).toBe(false)
    expect(await verifyGuestSecret(ID, secret, KEY, OTHER_WS)).toBe(false)
    expect(await verifyGuestSecret(ID, secret, OTHER_KEY)).toBe(false)
  })

  test("is false, never a throw, on every malformed input", async () => {
    const secret = await signGuestSecret(ID, KEY)
    const badSecrets: unknown[] = [
      undefined,
      null,
      "",
      42,
      {},
      [secret],
      secret.toUpperCase(),
      `${secret}0`,
      secret.slice(1),
      " ".repeat(64),
      "x".repeat(10_000),
    ]
    for (const bad of badSecrets) {
      expect(await verifyGuestSecret(ID, bad, KEY)).toBe(false)
    }
    const badIds: unknown[] = [undefined, null, "", 7, "123456", `${ID}x`, UUID]
    for (const bad of badIds) {
      expect(await verifyGuestSecret(bad, secret, KEY)).toBe(false)
    }
    const badKeys: unknown[] = [undefined, null, "", "short", 32]
    for (const bad of badKeys) {
      expect(await verifyGuestSecret(ID, secret, bad)).toBe(false)
    }
  })

  test("property: random well-formed secrets never verify", async () => {
    for (let i = 0; i < 500; i++) {
      const bytes = crypto.getRandomValues(new Uint8Array(32))
      const guess = Array.from(bytes, (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("")
      expect(await verifyGuestSecret(ID, guess, KEY)).toBe(false)
    }
  })
})
