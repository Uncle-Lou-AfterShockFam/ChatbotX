import { describe, expect, test } from "vitest"
import {
  sendPageStepDefaultFn,
  sendPageStepSchema,
} from "../src/steps/send-page"

describe("sendPage step schema (s227a)", () => {
  test("the default has success + error states, no page and no TTL override", () => {
    const step = sendPageStepDefaultFn()
    expect(step.stepType).toBe("sendPage")
    expect(step.pageId).toBeUndefined()
    expect(step.ttlHours).toBeUndefined()
    expect(step.states).toHaveLength(2)
    expect(sendPageStepSchema.parse(step)).toEqual(step)
    expect(sendPageStepSchema.parse({ ...step, ttlHours: 2160 }).ttlHours).toBe(
      2160,
    )
  })

  test("refuses a wrong stepType, a missing state tuple, a bad page id or TTL", () => {
    const step = sendPageStepDefaultFn()
    for (const bad of [
      { ...step, stepType: "sendDocumentForSignature" },
      { ...step, states: [] },
      { ...step, pageId: 5 },
      { ...step, ttlHours: 0 },
      { ...step, ttlHours: 2161 },
      { ...step, ttlHours: 1.5 },
      { ...step, ttlHours: "24" },
      null,
      "x",
    ]) {
      expect(sendPageStepSchema.safeParse(bad).success).toBe(false)
    }
  })
})
