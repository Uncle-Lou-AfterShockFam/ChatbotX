// @vitest-environment node
import { describe, expect, test } from "vitest"
import { listContactsRequest } from "@/features/contacts/schema/query"

describe("listContactsRequest contactFilter search param", () => {
  test("parses a JSON contactFilter query value", () => {
    const parsed = listContactsRequest.parse({
      workspaceId: "1",
      contactFilter: JSON.stringify({
        operator: "and",
        conditions: [
          {
            field: "inbox",
            operator: "eq",
            value: ["123"],
          },
        ],
      }),
    })

    expect(parsed.contactFilter).toEqual({
      operator: "and",
      conditions: [
        {
          field: "inbox",
          operator: "eq",
          value: ["123"],
        },
      ],
    })
  })

  test("rejects a malformed contactFilter query value (s206: never widens)", () => {
    const parsed = listContactsRequest.safeParse({
      workspaceId: "1",
      contactFilter: "{invalid",
    })

    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues[0]?.path).toEqual(["contactFilter"])
  })

  test("treats a blank contactFilter query value as absent", () => {
    for (const contactFilter of ["", "   "]) {
      expect(
        listContactsRequest.parse({ workspaceId: "1", contactFilter })
          .contactFilter,
      ).toBeUndefined()
    }
  })

  test("accepts valueless operators without a value", () => {
    const parsed = listContactsRequest.parse({
      workspaceId: "1",
      contactFilter: JSON.stringify({
        operator: "and",
        conditions: [
          {
            field: "fullName",
            operator: "isNotEmpty",
          },
        ],
      }),
    })

    expect(parsed.contactFilter?.conditions[0]).toEqual({
      field: "fullName",
      operator: "isNotEmpty",
    })
  })

  test("accepts locale and timezone select values", () => {
    const parsed = listContactsRequest.parse({
      workspaceId: "1",
      contactFilter: JSON.stringify({
        operator: "and",
        conditions: [
          {
            field: "locale",
            operator: "eq",
            value: ["vi_VN"],
          },
          {
            field: "timezone",
            operator: "eq",
            value: ["Asia/Ho_Chi_Minh"],
          },
        ],
      }),
    })

    expect(parsed.contactFilter?.conditions).toHaveLength(2)
  })

  test("rejects disabled operators for a field", () => {
    const parsed = listContactsRequest.safeParse({
      workspaceId: "1",
      contactFilter: JSON.stringify({
        operator: "and",
        conditions: [
          {
            field: "blocked",
            operator: "contains",
            value: "true",
          },
        ],
      }),
    })

    expect(parsed.success).toBe(false)
  })
})
