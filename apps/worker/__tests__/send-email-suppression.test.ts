// @vitest-environment node
import { describe, expect, test, vi } from "vitest"

vi.mock("@chatbotx.io/business/email-suppression", () => ({
  emailSuppressionService: { isSuppressed: vi.fn() },
}))

const { recipientAddresses } = await import(
  "../src/integration/handlers/send-email-suppression"
)

describe("recipientAddresses (s224b): the addresses nodemailer will really mail", () => {
  test("quoted names, groups, comments and quoted locals resolve like nodemailer's send (Codex probe s224b)", () => {
    const cases: [string, string[]][] = [
      ['"Doe, Jane" <jane@example.com>', ["jane@example.com"]],
      ["Team:bob@example.com;", ["bob@example.com"]],
      [
        "Team: bob@example.com, eve@example.com;",
        ["bob@example.com", "eve@example.com"],
      ],
      ['"bob"@example.com', ["bob@example.com"]],
      ["<bob@blocked.com> <alice@allowed.com>", ["bob@blocked.com"]],
      ["x@y.com (comment)", ["x@y.com"]],
      [
        "a@ok.com, Bee <b@blocked.com>; c@ok.com",
        ["a@ok.com", "b@blocked.com", "c@ok.com"],
      ],
    ]
    for (const [to, expected] of cases) {
      expect(recipientAddresses(to), to).toEqual(expected)
    }
  })

  test("nothing, too many, an entry with no address, or a non-string is null (fail closed)", () => {
    for (const to of [
      "",
      " , ; ",
      "nope",
      "a@b.com, nope",
      5,
      null,
      undefined,
    ]) {
      expect(recipientAddresses(to), String(to)).toBeNull()
    }
    expect(
      recipientAddresses(new Array(51).fill("a@b.com").join(",")),
    ).toBeNull()
    expect(
      recipientAddresses(new Array(50).fill("a@b.com").join(",")),
    ).toHaveLength(50)
  })
})
