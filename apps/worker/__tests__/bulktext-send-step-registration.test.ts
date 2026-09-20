import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"
import { MESSAGE_PRODUCING_STEP_TYPES } from "../src/integration/handlers/flow-utils"

describe("bulktextSend worker registration", () => {
  test("dispatches to sendFlowMessage like every other send step", () => {
    const source = readFileSync("src/integration/handlers/step.ts", "utf8")
    expect(source).toContain("[stepTypes.enum.bulktextSend]: sendFlowMessage")
  })

  test("counts as message-producing (claims a comment anchor, first outgoing)", () => {
    expect(MESSAGE_PRODUCING_STEP_TYPES.has("bulktextSend")).toBe(true)
  })

  test("the chat sender reads its text and treats photo-only as a send", () => {
    const source = readFileSync("src/chat/handlers/send-flow-step.ts", "utf8")
    expect(source).toContain(
      "resolvedStep.stepType === stepTypes.enum.bulktextSend",
    )
    expect(source).toContain("step.stepType === stepTypes.enum.bulktextSend")
  })
})
