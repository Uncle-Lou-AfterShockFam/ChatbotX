import { describe, expect, test } from "vitest"
import {
  sendDocumentForSignatureStepDefaultFn,
  sendDocumentForSignatureStepSchema,
} from "../src/steps/send-document-for-signature"

describe("sendDocumentForSignature step schema", () => {
  test("the default has success + error states and no template", () => {
    const step = sendDocumentForSignatureStepDefaultFn()
    expect(step.stepType).toBe("sendDocumentForSignature")
    expect(step.templateId).toBeUndefined()
    expect(step.states).toHaveLength(2)
    expect(sendDocumentForSignatureStepSchema.parse(step)).toEqual(step)
  })

  test("refuses a wrong stepType, a missing state tuple and a non-string template", () => {
    const step = sendDocumentForSignatureStepDefaultFn()
    for (const bad of [
      { ...step, stepType: "triggerN8n" },
      { ...step, states: [] },
      { ...step, templateId: 5 },
      null,
      "x",
    ]) {
      expect(sendDocumentForSignatureStepSchema.safeParse(bad).success).toBe(
        false,
      )
    }
  })
})
