import { describe, expect, test } from "vitest"
import { isBase62Token, mintBase62Token } from "../src/base62-token"

describe("base62 tokens", () => {
  test("renders exactly tokenLength characters from byteLength random bytes", () => {
    expect(mintBase62Token(8, 11, () => new Uint8Array(8))).toBe("0".repeat(11))
    expect(mintBase62Token(1, 3, () => new Uint8Array([61]))).toBe("00z")
    const t = mintBase62Token(16, 22)
    expect(isBase62Token(t, 22)).toBe(true)
  })

  test("isBase62Token rejects wrong length, other characters, non-strings", () => {
    for (const bad of [
      "",
      "abc",
      `${"a".repeat(21)}!`,
      `${"a".repeat(21)}-`,
      null,
      22,
    ]) {
      expect(isBase62Token(bad, 22)).toBe(false)
    }
  })

  test("mints are unique and use every position of the alphabet over many draws", () => {
    const seen = new Set(
      Array.from({ length: 500 }, () => mintBase62Token(16, 22)),
    )
    expect(seen.size).toBe(500)
    const chars = new Set([...seen].join(""))
    expect(chars.size).toBe(62)
  })
})
