import { describe, expect, test } from "vitest"
import { parseCreateBroadcastPrefill } from "../create-broadcast-prefill"

describe("parseCreateBroadcastPrefill", () => {
  test("parses channel, integrationWhatsappId, and a ctwaRetarget contactFilter", () => {
    const contactFilter = {
      operator: "and",
      conditions: [
        {
          field: "ctwaRetarget",
          segment: "purchases",
          adId: "238512000000102",
          since: "2026-07-01",
          until: "2026-07-31",
        },
      ],
    }

    const result = parseCreateBroadcastPrefill({
      channel: "whatsapp",
      integrationWhatsappId: "12345",
      contactFilter: JSON.stringify(contactFilter),
    })

    expect(result.channel).toBe("whatsapp")
    expect(result.integrationWhatsappId).toBe("12345")
    expect(result.contactFilter).toEqual(contactFilter)
    expect(result.invalidContactFilter).toBe(false)
  })

  test("returns no prefill for absent search params", () => {
    expect(parseCreateBroadcastPrefill({})).toEqual({
      contactFilter: undefined,
      invalidContactFilter: false,
    })
  })

  test.each([
    ["malformed JSON", "not-json"],
    ["a schema-invalid filter", JSON.stringify({ operator: "xor" })],
    [
      "an unknown field",
      JSON.stringify({ operator: "and", conditions: [{ field: "nope" }] }),
    ],
    ["a repeated param", ["{}", "{}"]],
  ])("flags %s as invalid, never an unfiltered audience (s206)", (_label, contactFilter) => {
    const result = parseCreateBroadcastPrefill({
      channel: "whatsapp",
      contactFilter,
    })

    expect(result.channel).toBe("whatsapp")
    expect(result.contactFilter).toBeUndefined()
    expect(result.invalidContactFilter).toBe(true)
  })

  test("drops an invalid channel but keeps the filter verdict", () => {
    expect(
      parseCreateBroadcastPrefill({
        channel: "not-a-real-channel",
      }),
    ).toEqual({ contactFilter: undefined, invalidContactFilter: false })
    expect(
      parseCreateBroadcastPrefill({
        channel: "not-a-real-channel",
        contactFilter: "{bad",
      }).invalidContactFilter,
    ).toBe(true)
  })
})
