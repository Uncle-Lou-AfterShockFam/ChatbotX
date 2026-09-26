import { describe, expect, test } from "vitest"
import { nameInitials } from "../src/initials"

const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

describe("nameInitials", () => {
  test("ASCII names keep the old two-character behaviour", () => {
    expect(nameInitials("Lou Piotti")).toBe("Lo")
    expect(nameInitials("A")).toBe("A")
    expect(nameInitials("Lou", 1)).toBe("L")
  })

  test("never splits a surrogate pair", () => {
    expect(nameInitials("J\u{1F600}hn")).toBe("J\u{1F600}")
    expect(nameInitials("\u{1F600}\u{1F601}x")).toBe("\u{1F600}\u{1F601}")
  })

  test("counts code points, the same on every engine: ZWJ family, flag, combining mark", () => {
    expect(nameInitials("\u{1F468}\u200D\u{1F469}Smith")).toBe(
      "\u{1F468}\u200D",
    )
    expect(nameInitials("\u{1F1FA}\u{1F1F8}USA")).toBe("\u{1F1FA}\u{1F1F8}")
    expect(nameInitials("e\u0301mile")).toBe("e\u0301")
  })

  test("empty, null, undefined, non-string and a non-positive count give an empty string", () => {
    expect(nameInitials("")).toBe("")
    expect(nameInitials(null)).toBe("")
    expect(nameInitials(undefined)).toBe("")
    expect(nameInitials(42 as unknown as string)).toBe("")
    expect(nameInitials("Lou", 0)).toBe("")
    expect(nameInitials("Lou", -1)).toBe("")
  })

  test("fuzz: output is a prefix of the input and never ends on a lone surrogate", () => {
    const pool = [
      "a",
      "\u{1F600}",
      "‍",
      "́",
      "\u{1F1FA}",
      "\u{1F1F8}",
      "\uD83D",
      "\uDE00",
      " ",
    ]
    let seed = 209
    const rand = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31
      return seed / 2 ** 31
    }
    for (let i = 0; i < 2000; i++) {
      let s = ""
      const len = Math.floor(rand() * 8)
      for (let j = 0; j < len; j++) {
        s += pool[Math.floor(rand() * pool.length)]
      }
      const out = nameInitials(s)
      expect(s.startsWith(out)).toBe(true)
      if (!LONE_SURROGATE.test(s)) {
        expect(LONE_SURROGATE.test(out)).toBe(false)
      }
    }
  })
})
