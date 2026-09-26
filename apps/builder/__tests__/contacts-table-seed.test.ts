// @vitest-environment node
import { describe, expect, test } from "vitest"
import {
  listInputKey,
  seedForFirstKey,
} from "@/features/contacts/lib/seed-first-key"

describe("contacts list first-page seed (s203)", () => {
  const first = {
    workspaceId: "w",
    page: 1,
    perPage: 50,
    contactFilter: undefined,
  }
  const initial = { data: ["all"], pageCount: 1 }

  test("the first key is seeded with the RSC page", () => {
    const key = listInputKey(first)
    expect(seedForFirstKey(key, key, initial)).toBe(initial)
  })

  test("a changed filter, page or sort is never seeded (it must fetch)", () => {
    const initialKey = listInputKey(first)
    const filtered = {
      ...first,
      contactFilter: { operator: "and", conditions: [{ field: "tags" }] },
    }
    expect(
      seedForFirstKey(listInputKey(filtered), initialKey, initial),
    ).toBeUndefined()
    expect(
      seedForFirstKey(listInputKey({ ...first, page: 2 }), initialKey, initial),
    ).toBeUndefined()
  })
})
