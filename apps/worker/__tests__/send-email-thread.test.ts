// @vitest-environment node
import { describe, expect, test, vi } from "vitest"

vi.mock("@chatbotx.io/business/email-thread", async () => {
  const actual = await vi.importActual<
    typeof import("@chatbotx.io/business/email-thread")
  >("@chatbotx.io/business/email-thread")
  return { isCitableMsgId: actual.isCitableMsgId, emailThreadMailService: {} }
})
const { ContentError } = vi.hoisted(() => ({
  ContentError: class extends Error {},
}))
vi.mock("../src/integration/handlers/send-email-document", () => ({
  EmailContentError: ContentError,
}))
vi.mock("../src/integration/handlers/send-email-line", () => ({
  LINE_EMAIL_LIMITS: {
    subject: 200,
    htmlBytes: 1,
    textBytes: 1,
    threadKeys: 20,
  },
}))

const {
  broadcastIdOf,
  citeParent,
  MESSAGE_KEY,
  mintMessageKey,
  threadModeOf,
  replySubject,
  sequenceIdOf,
  sequenceSendIdOf,
} = await import("../src/integration/handlers/send-email-thread")

describe("send-email-thread (s225b)", () => {
  test("a minted key always passes the line's MESSAGE_KEY shape and never repeats", () => {
    const seen = new Set<string>()
    for (let i = 0; i < 2000; i++) {
      const k = mintMessageKey()
      expect(k).toMatch(MESSAGE_KEY)
      seen.add(k)
    }
    expect(seen.size).toBe(2000)
  })

  test("MESSAGE_KEY refuses header injection and bad edges (the same regex the line uses)", () => {
    for (const bad of [
      "short",
      "a".repeat(65),
      "a@b.example",
      "<abcdefgh>",
      "abc defgh",
      "abcdefg\r\nBcc: x",
      ".abcdefgh",
      "abcdefgh.",
    ]) {
      expect(MESSAGE_KEY.test(bad)).toBe(false)
    }
    expect(MESSAGE_KEY.test("bt.root-000001")).toBe(true)
  })

  test("sequenceIdOf reads only a real sequence id", () => {
    const meta = (sequenceId: unknown) =>
      ({ type: "sequenceSchedule", sequenceId }) as never
    expect(sequenceIdOf(meta("555"))).toBe("555")
    for (const junk of ["", "1; drop", 5, null, undefined, "1".repeat(20)]) {
      expect(sequenceIdOf(meta(junk))).toBeUndefined()
    }
    expect(sequenceIdOf(undefined)).toBeUndefined()
    expect(
      sequenceIdOf({ type: "broadcast", sequenceId: "555" } as never),
    ).toBeUndefined()
  })

  test("a derived key is stable per send id, distinct across ids, and still a valid key", () => {
    expect(mintMessageKey("ws:c:1:d:s")).toBe(mintMessageKey("ws:c:1:d:s"))
    expect(mintMessageKey("ws:c:1:d:s")).not.toBe(mintMessageKey("ws:c:1:d2:s"))
    for (let i = 0; i < 500; i++) {
      expect(mintMessageKey(`ws:c:1:${i}:s`)).toMatch(MESSAGE_KEY)
    }
  })

  test("sequenceSendIdOf needs a sequence dispatch id", () => {
    const meta = (dispatchId: unknown) =>
      ({ type: "sequenceSchedule", dispatchId }) as never
    expect(sequenceSendIdOf(meta("123"), "step-1")).toBe("123:step-1")
    for (const junk of ["", "a b", 5, null, undefined, "x".repeat(65)]) {
      expect(sequenceSendIdOf(meta(junk), "step-1")).toBeUndefined()
    }
    expect(sequenceSendIdOf(undefined, "step-1")).toBeUndefined()
  })

  test("replySubject never doubles Re:", () => {
    expect(replySubject("Saturday")).toBe("Re: Saturday")
    expect(replySubject("  Re: Saturday ")).toBe("Re: Saturday")
    expect(replySubject("RE: x")).toBe("RE: x")
  })

  test("replySubject fits the line's 200-char cap even for a 197..200-char first subject", () => {
    for (const n of [196, 197, 200]) {
      const r = replySubject("a".repeat(n))
      expect(r.startsWith("Re: ")).toBe(true)
      expect(r.length).toBeLessThanOrEqual(200)
    }
    expect(replySubject("a".repeat(196))).toBe(`Re: ${"a".repeat(196)}`)
  })

  test("threadModeOf: unset keeps s225b (text in a sequence = previous, else none); a set mode wins", () => {
    expect(threadModeOf({}, "text", { sequenceId: "5" })).toBe("previous")
    expect(threadModeOf({}, "html", { sequenceId: "5" })).toBe("none")
    expect(threadModeOf({}, "text", { flowId: "9" })).toBe("none")
    expect(threadModeOf({ threadMode: "latest" }, "html", {})).toBe("latest")
  })

  test("broadcastIdOf reads only a real broadcast id", () => {
    const meta = (broadcastId: unknown) =>
      ({ type: "broadcast", broadcastId }) as never
    expect(broadcastIdOf(meta("42"))).toBe("42")
    expect(broadcastIdOf(meta(42))).toBe("42")
    for (const junk of ["", "b-1", null, undefined, "1".repeat(20)]) {
      expect(broadcastIdOf(meta(junk))).toBeUndefined()
    }
    expect(
      broadcastIdOf({ type: "sequenceSchedule", broadcastId: "42" } as never),
    ).toBeUndefined()
  })

  test("citeParent: the parent's parents, then the parent itself (key bare, foreign id bracketed), oldest first", () => {
    expect(
      citeParent({
        direction: "outgoing",
        messageKey: "bt.two-0000001",
        messageId: null,
        parents: ["bt.root-000001", "<x@y.example>"],
      }),
    ).toEqual(["bt.root-000001", "<x@y.example>", "bt.two-0000001"])
    expect(
      citeParent({
        direction: "incoming",
        messageKey: null,
        messageId: "<own@y.example>",
        parents: ["<bt.root-000001@a.example>"],
      }),
    ).toEqual(["<bt.root-000001@a.example>", "<own@y.example>"])
  })

  test("citeParent keeps the TRUE root of a mixed two-way thread past the cap (skeptic s226b)", () => {
    // root key, then 24 alternating replies/follow-ups
    const parents = ["bt.root-000001"]
    for (let i = 0; i < 24; i++) {
      parents.push(i % 2 ? `bt.f${i}-0000001` : `<r${i}@y.example>`)
    }
    const chain = citeParent({
      direction: "incoming",
      messageKey: null,
      messageId: "<newest@y.example>",
      parents,
    })
    expect(chain).toHaveLength(20)
    expect(chain[0]).toBe("bt.root-000001")
    expect(chain.at(-1)).toBe("<newest@y.example>")
  })

  test("citeParent fails closed on anything the line would refuse", () => {
    for (const bad of [
      { messageKey: "x@evil.example", parents: [] },
      { messageKey: "bt.ok-0000001", parents: ["<a@b>\r\nBcc: x@y"] },
      { messageKey: "bt.ok-0000001", parents: ["not a key"] },
      { messageKey: "bt.ok-0000001", parents: ["bt.ok-0000001"] },
      { messageKey: null, parents: [] },
    ]) {
      expect(() =>
        citeParent({
          direction: "outgoing",
          messageId: null,
          ...bad,
        } as never),
      ).toThrow(ContentError)
    }
  })
})
