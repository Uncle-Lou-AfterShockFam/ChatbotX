import { describe, expect, test } from "vitest"
import {
  clipText,
  MENTION_LABEL_MAX,
  mentionToken,
  parseMentions,
  renderMentionsPlain,
  splitMentions,
} from "../src/mentions"

describe("deal-comment mention tokens (s193)", () => {
  test("parses `@[Label](u:<id>)` tokens in order, collapsing duplicate ids to the first label", () => {
    expect(
      parseMentions(
        "hi @[Demo](u:11701868563234816) and @[Lou](u:2) and @[Demo again](u:11701868563234816)",
      ),
    ).toEqual([
      { userId: "11701868563234816", label: "Demo" },
      { userId: "2", label: "Lou" },
    ])
  })

  test.each([
    ["@[Demo](u:abc)", "non-numeric id"],
    ["@[](u:1)", "empty label"],
    ["@[Demo](u:)", "empty id"],
    ["@[Demo](1)", "missing u: prefix"],
    ["@[Demo]\n(u:1)", "newline between"],
    ["@Demo", "bare handle"],
    ["[Demo](u:1)", "no @"],
    ["@[Demo](u:123456789012345678901)", "21-digit id"],
    [`@[${"x".repeat(61)}](u:1)`, "61-char label"],
  ])("leaves %j as text (%s)", (body) => {
    expect(parseMentions(body)).toEqual([])
    expect(renderMentionsPlain(body)).toBe(body)
  })

  test("null / non-string / empty bodies parse to nothing", () => {
    expect(parseMentions("")).toEqual([])
    expect(parseMentions(null as never)).toEqual([])
    expect(parseMentions(42 as never)).toEqual([])
    expect(renderMentionsPlain(undefined as never)).toBe("")
  })

  test("renders tokens as @Label for activity lines and texts", () => {
    expect(
      renderMentionsPlain("ping @[Demo User](u:1), thanks @[Lou](u:2)!"),
    ).toBe("ping @Demo User, thanks @Lou!")
  })

  test("unicode labels and nested brackets", () => {
    expect(parseMentions("@[Zoë Ünal](u:7)")).toEqual([
      { userId: "7", label: "Zoë Ünal" },
    ])
    // the first `]` closes the label, so a nested `]` breaks the token
    expect(parseMentions("@[a]b](u:1)")).toEqual([])
    expect(parseMentions("@[a[b](u:1)")).toEqual([
      { userId: "1", label: "a[b" },
    ])
  })

  test("a 10 KB body with 200 tokens parses in bounded time and keeps every distinct id", () => {
    const body = Array.from(
      { length: 200 },
      (_, i) => `@[User ${i}](u:${i + 1}) ${"x".repeat(40)}`,
    ).join(" ")
    const t0 = Date.now()
    const refs = parseMentions(body)
    expect(Date.now() - t0).toBeLessThan(200)
    expect(refs).toHaveLength(200)
  })

  test("mentionToken clips the label, strips `]` and newlines, falls back to the id", () => {
    expect(mentionToken({ userId: "1", label: "Lou" })).toBe("@[Lou](u:1)")
    expect(mentionToken({ userId: "1", label: "a]b\nc" })).toBe("@[a b c](u:1)")
    expect(mentionToken({ userId: "1", label: "" })).toBe("@[1](u:1)")
    const long = mentionToken({ userId: "1", label: "y".repeat(100) })
    expect(parseMentions(long)[0].label).toHaveLength(MENTION_LABEL_MAX)
  })

  test("splitMentions yields text runs and tokens in order (adjacent tokens, leading/trailing text)", () => {
    expect(splitMentions("hi @[A](u:1)@[B](u:2) bye")).toEqual([
      { kind: "text", text: "hi " },
      { kind: "mention", userId: "1", label: "A" },
      { kind: "mention", userId: "2", label: "B" },
      { kind: "text", text: " bye" },
    ])
    expect(splitMentions("")).toEqual([])
    expect(splitMentions("plain")).toEqual([{ kind: "text", text: "plain" }])
  })

  test("clipText counts code points and never splits a surrogate pair", () => {
    expect(clipText("abc", 3)).toBe("abc")
    expect(clipText("abcd", 3)).toBe("ab\u2026")
    const clipped = clipText("ab\u{1F600}cd", 3)
    expect(Array.from(clipped)).toEqual(["a", "b", "\u2026"])
    expect(clipText("a\u{1F600}\u{1F600}", 3)).toBe("a\u{1F600}\u{1F600}")
  })
})
