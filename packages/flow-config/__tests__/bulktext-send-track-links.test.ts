import { describe, expect, test } from "vitest"
import {
  bulktextSendOptions,
  bulktextSendStepDefaultFn,
  bulktextSendStepSchema,
} from "../src/steps/bulktext-send"

describe("bulktextSend trackLinks", () => {
  test("defaults off and round-trips through the schema", () => {
    const step = bulktextSendStepDefaultFn({ text: "hi" })
    expect(step.trackLinks).toBe(false)
    const on = bulktextSendStepSchema.parse({ ...step, trackLinks: true })
    expect(on.trackLinks).toBe(true)
  })

  test("never reaches the worker's options (bulktext refuses unknown keys)", () => {
    const step = bulktextSendStepDefaultFn({ text: "hi", trackLinks: true })
    expect(Object.keys(bulktextSendOptions(step))).not.toContain("trackLinks")
  })

  test("a graph saved before the option existed still publishes: a missing key reads as false (s165: the required boolean 422'd every older flow)", () => {
    const { trackLinks: _omitted, ...withoutKey } = bulktextSendStepDefaultFn({
      text: "hi",
    })
    const parsed = bulktextSendStepSchema.parse(withoutKey)
    expect(parsed.trackLinks).toBe(false)
  })

  test("a non-boolean is rejected", () => {
    const step = bulktextSendStepDefaultFn({ text: "hi" })
    expect(
      bulktextSendStepSchema.safeParse({ ...step, trackLinks: "yes" }).success,
    ).toBe(false)
  })
})
