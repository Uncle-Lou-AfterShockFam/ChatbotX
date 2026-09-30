import { describe, expect, test } from "vitest"
import {
  publicUpsertSequenceStepRequest,
  upsertSequenceStepRequest,
} from "@/features/sequences/schema/action"

const base = { sequenceId: "1", order: 0 }

describe("s227b: step holdOnMissing", () => {
  test("accepts up to 10 merge-field names, null, or omitted", () => {
    const names = Array.from({ length: 10 }, (_, i) => `field ${i}`)
    expect(
      upsertSequenceStepRequest.parse({ ...base, holdOnMissing: names })
        .holdOnMissing,
    ).toEqual(names)
    expect(
      upsertSequenceStepRequest.parse({ ...base, holdOnMissing: null })
        .holdOnMissing,
    ).toBeNull()
    expect(upsertSequenceStepRequest.parse(base).holdOnMissing).toBeUndefined()
    expect(
      publicUpsertSequenceStepRequest.parse({
        order: 0,
        holdOnMissing: ["first_name"],
      }).holdOnMissing,
    ).toEqual(["first_name"])
  })

  test.each([
    ["11 names", Array.from({ length: 11 }, (_, i) => `f${i}`)],
    ["an empty name", [" "]],
    ["a brace", ["{{first_name}}"]],
    ["a pipe", ["first_name|x"]],
    ["a newline", ["a\nb"]],
    ["a 101-char name", ["x".repeat(101)]],
    ["not an array", "first_name"],
    ["a non-string", [1]],
  ])("refuses %s", (_label, holdOnMissing) => {
    expect(
      upsertSequenceStepRequest.safeParse({ ...base, holdOnMissing }).success,
    ).toBe(false)
  })
})
