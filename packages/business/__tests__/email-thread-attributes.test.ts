// @vitest-environment node
import { describe, expect, test } from "vitest"
import {
  autoReplyClass,
  inboundEmailAttributes,
  isCitableMsgId,
  isOutOfOffice,
} from "../src/email-thread"

describe("email thread attributes (s226b)", () => {
  test("isCitableMsgId: strict <dot-atom@host>, capped at 250", () => {
    expect(isCitableMsgId("<CAK.1+x@mail.gmail.com>")).toBe(true)
    for (const bad of [
      "no-brackets@x.example",
      "<a@b>\r\nBcc: x@y",
      "<a..b@x.example>",
      "<a(b)@x.example>",
      `<${"a".repeat(250)}@x.example>`,
      "<@x.example>",
      42,
      null,
    ]) {
      expect(isCitableMsgId(bad)).toBe(false)
    }
  })

  test("inboundEmailAttributes: only a citable, non-automatic mail; refs deduped, own id dropped, uncitable dropped, newest 20 kept", () => {
    const refs = Array.from({ length: 25 }, (_, i) => `<r${i}@y.example>`)
    const got = inboundEmailAttributes({
      email: {
        messageId: "<own@y.example>",
        subject: "Re: Hi",
        references: [...refs, "<own@y.example>", "junk", refs[3]],
      },
    })
    expect(got?.messageId).toBe("<own@y.example>")
    expect(got?.references).toHaveLength(20)
    expect(got?.references.at(-1)).toBe("<r24@y.example>")
    expect(got?.references).not.toContain("<own@y.example>")
    for (const bad of [
      null,
      "x",
      {},
      { email: null },
      { email: { messageId: "bad" } },
      { email: { messageId: "<a@b.example>", autoReply: "ooo" } },
    ]) {
      expect(inboundEmailAttributes(bad)).toBeNull()
    }
    expect(
      inboundEmailAttributes({
        email: { messageId: "<a@b.example>", subject: "x".repeat(2000) },
      })?.subject,
    ).toHaveLength(998)
  })

  test("s229b: email.sender is kept only as a bigint id string; anything else is dropped, never the mail", () => {
    const mail = (sender: unknown) =>
      inboundEmailAttributes({
        email: { messageId: "<a@b.example>", subject: "Hi", sender },
      })
    expect(mail("117")?.sender).toBe("117")
    for (const bad of [
      undefined,
      null,
      117,
      "",
      "abc",
      "1".repeat(20),
      "1; drop",
      { id: "1" },
    ]) {
      const got = mail(bad)
      expect(got?.messageId).toBe("<a@b.example>")
      expect(got && "sender" in got).toBe(false)
    }
  })

  test("isOutOfOffice: only email.autoReply === 'ooo'", () => {
    expect(isOutOfOffice({ email: { autoReply: "ooo" } })).toBe(true)
    for (const no of [
      null,
      undefined,
      "ooo",
      {},
      { email: {} },
      { email: { autoReply: "auto" } },
      { autoReply: "ooo" },
    ]) {
      expect(isOutOfOffice(no)).toBe(false)
    }
  })

  test("autoReplyClass (s228b): exactly ooo or auto, anything else is a person", () => {
    expect(autoReplyClass({ email: { autoReply: "ooo" } })).toBe("ooo")
    expect(autoReplyClass({ email: { autoReply: "auto" } })).toBe("auto")
    for (const no of [
      null,
      undefined,
      "auto",
      {},
      { email: null },
      { email: { autoReply: "bounce" } },
      { email: { autoReply: "AUTO" } },
      { email: { autoReply: ["auto"] } },
      { autoReply: "auto" },
    ]) {
      expect(autoReplyClass(no)).toBeUndefined()
    }
  })
})
