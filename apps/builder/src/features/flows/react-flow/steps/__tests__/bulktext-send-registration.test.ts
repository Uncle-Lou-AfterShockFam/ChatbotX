import { readFileSync } from "node:fs"
import {
  bulktextSendStepDefaultFn,
  bulktextSendStepSchema,
  stepTypes,
} from "@chatbotx.io/flow-config"
import { describe, expect, test } from "vitest"

const API_MENU_FIRST = /API_MENU_ORDER = \[\s*"bulktextSend"/
const OMNICHANNEL_EXCLUDED =
  /OMNICHANNEL_EXCLUDED_ITEMS = new Set\(\[[^\]]*"bulktextSend"/

describe("bulktextSend step registration", () => {
  test("defines the type and a dry default", () => {
    const defaults = bulktextSendStepDefaultFn()
    expect(stepTypes.enum.bulktextSend).toBe("bulktextSend")
    expect(defaults.dryRun).toBe(true)
    expect(defaults.text).toBe("")
    expect(
      bulktextSendStepSchema.safeParse({ ...defaults, text: "hi" }).success,
    ).toBe(true)
  })

  test("is wired into the builder step registry", () => {
    const source = readFileSync(
      "src/features/flows/react-flow/steps/index.tsx",
      "utf8",
    )
    expect(source).toContain(
      'import { bulktextSendStep } from "./bulktext-send"',
    )
    expect(source).toContain("[stepTypes.enum.bulktextSend]: bulktextSendStep")
  })

  test("is offered on API-channel send nodes only", () => {
    const source = readFileSync(
      "src/features/flows/react-flow/nodes/send-message/menu.tsx",
      "utf8",
    )
    expect(source).toContain("stepType: stepTypes.enum.bulktextSend")
    expect(source).toMatch(API_MENU_FIRST)
    expect(source).toMatch(OMNICHANNEL_EXCLUDED)
  })
})
