import { describe, expect, test, vi } from "vitest"

// The public OpenAPI document (apps/builder /api/public-spec.json) is built
// from these schemas and cached by a SHA1 ETag. Any schema whose evaluation
// has a side effect -- a `.default(() => createId())` minting a snowflake --
// makes two generations differ, and under fake timers the snowflake clock
// throws "Clock moved backwards". Three fork CI runs on main failed that way
// (public-spec-json-route.test.ts:72) after PR #20 put a state default inside
// the wait step schema. This gate fails on the next such schema.
const mocks = vi.hoisted(() => ({ createId: vi.fn(() => "MINTED") }))

vi.mock("@chatbotx.io/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@chatbotx.io/utils")>()
  return { ...actual, createId: mocks.createId }
})

const { flowVersionSchema, edgeSchema } = await import("../src/nodes")

const toJson = (schema: Parameters<typeof z.toJSONSchema>[0]) =>
  JSON.stringify(
    z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }),
  )
const { z } = await import("zod")

describe("flow schemas are deterministic", () => {
  test("converting the node + edge schemas to JSON schema mints no id and yields the same document twice", () => {
    mocks.createId.mockClear()
    const first = toJson(flowVersionSchema) + toJson(edgeSchema)
    const second = toJson(flowVersionSchema) + toJson(edgeSchema)
    expect(second).toBe(first)
    expect(first).not.toContain("MINTED")
    expect(mocks.createId).not.toHaveBeenCalled()
  })

  test("adversarial: the conversion survives frozen time (the snowflake clock would throw)", () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date("2000-01-01T00:00:00.000Z"))
      expect(() => toJson(flowVersionSchema)).not.toThrow()
    } finally {
      vi.useRealTimers()
    }
  })
})
