import { describe, expect, test } from "vitest"
import {
  GUEST_CONVERSATION_ID_REGEX,
  isMintedGuestConversationId,
} from "../src/guest-id"

// An independent oracle for the property test (not the module's own regex).
const ORACLE =
  /^\d{1,20}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const WS = "11701868563365888"
const UUID = "0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f"
const MINTED = `${WS}:${UUID}`

describe("isMintedGuestConversationId (s213)", () => {
  test("accepts the minted `<workspaceId>:<uuid>` form, any uuid case", () => {
    expect(isMintedGuestConversationId(MINTED)).toBe(true)
    expect(isMintedGuestConversationId(`${WS}:${crypto.randomUUID()}`)).toBe(
      true,
    )
    expect(isMintedGuestConversationId(`${WS}:${UUID.toUpperCase()}`)).toBe(
      true,
    )
  })

  test("binds the workspace prefix when one is given", () => {
    expect(isMintedGuestConversationId(MINTED, WS)).toBe(true)
    expect(isMintedGuestConversationId(MINTED, "1170186856336588")).toBe(false)
    expect(isMintedGuestConversationId(`9:${UUID}`, WS)).toBe(false)
  })

  test.each([
    ["null", null],
    ["undefined", undefined],
    ["a number", 1_161_677_328_115],
    ["an object", { toString: () => MINTED }],
    ["an array", [MINTED]],
    ["an empty string", ""],
    ["a legacy digits-only Snowflake", "11616773281153025"],
    ["a non-uuid suffix", `${WS}:guest-1`],
    ["a uuid with no prefix", UUID],
    ["a non-digit prefix", `workspace-1:${UUID}`],
    ["an empty prefix", `:${UUID}`],
    ["a trailing newline", `${MINTED}\n`],
    ["a leading space", ` ${MINTED}`],
    ["an embedded newline", `${WS}\n:${UUID}`],
    ["an extra segment", `${MINTED}:x`],
    ["a percent-encoded colon", `${WS}%3A${UUID}`],
    ["a path traversal", `../${MINTED}`],
    ["a 21-digit prefix", `${"1".repeat(21)}:${UUID}`],
    ["a 10 KB string", `${"1".repeat(10_000)}:${UUID}`],
  ])("refuses %s", (_, value) => {
    expect(isMintedGuestConversationId(value)).toBe(false)
    expect(isMintedGuestConversationId(value, WS)).toBe(false)
  })

  test("property: 2000 random strings pass only when they are the minted form", () => {
    const alphabet = "0123456789abcdefABCDEF:-\n %/xg"
    let passed = 0
    for (let i = 0; i < 2000; i++) {
      const length = Math.floor(Math.random() * 70)
      let value = ""
      for (let j = 0; j < length; j++) {
        value += alphabet[Math.floor(Math.random() * alphabet.length)]
      }
      // Half the samples are mutations of a real id, so the accept path is hit.
      if (i % 2 === 0) {
        const real = `${Math.floor(Math.random() * 1e15)}:${crypto.randomUUID()}`
        const at = Math.floor(Math.random() * real.length)
        value =
          i % 4 === 0
            ? real
            : real.slice(0, at) + value.slice(0, 1) + real.slice(at + 1)
      }
      const expected = value.length <= 57 && ORACLE.test(value)
      const actual = isMintedGuestConversationId(value)
      expect(actual, JSON.stringify(value)).toBe(expected)
      if (actual) {
        passed++
      }
    }
    expect(passed).toBeGreaterThan(400)
  })

  test("the regex is anchored (no partial match)", () => {
    expect(GUEST_CONVERSATION_ID_REGEX.test(`x${MINTED}`)).toBe(false)
    expect(GUEST_CONVERSATION_ID_REGEX.test(`${MINTED}x`)).toBe(false)
  })
})
