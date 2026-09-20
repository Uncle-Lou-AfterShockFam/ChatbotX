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

  test("is channel-deliverable: the chat sender's allowlist names it (s164: missing here meant every native step was skipped silently)", () => {
    const source = readFileSync("src/chat/handlers/send-flow-step.ts", "utf8")
    const start = source.indexOf(
      "const CHANNEL_DELIVERABLE_STEP_TYPES = new Set<string>([",
    )
    const end = source.indexOf("])", start)
    expect(start).toBeGreaterThan(-1)
    expect(source.slice(start, end)).toContain("stepTypes.enum.bulktextSend")
  })

  test("the chat sender reads its text and treats photo-only as a send", () => {
    const source = readFileSync("src/chat/handlers/send-flow-step.ts", "utf8")
    expect(source).toContain(
      "stepWithSignedBookingLinks.stepType === stepTypes.enum.bulktextSend",
    )
    expect(source).toContain("step.stepType === stepTypes.enum.bulktextSend")
  })
})

describe("bulktextSend tracked links (s165)", () => {
  test("the chat sender rewrites links after booking-link signing and reads its text off the tracked step", () => {
    const source = readFileSync("src/chat/handlers/send-flow-step.ts", "utf8")
    const tracked = source.indexOf("await trackBulktextLinksInStep({")
    const signed = source.indexOf("await signBookingLinksInStep({")
    const text = source.indexOf("const messageText =")
    expect(tracked).toBeGreaterThan(-1)
    expect(signed).toBeGreaterThan(tracked)
    expect(text).toBeGreaterThan(signed)
    expect(source.slice(text, text + 400)).toContain(
      "stepWithSignedBookingLinks.text",
    )
  })
})
