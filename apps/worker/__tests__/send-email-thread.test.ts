// @vitest-environment node
import { describe, expect, test, vi } from "vitest"

vi.mock("@chatbotx.io/business/email-thread", () => ({
  emailThreadService: { find: vi.fn() },
}))
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
  MESSAGE_KEY,
  mintMessageKey,
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
})
