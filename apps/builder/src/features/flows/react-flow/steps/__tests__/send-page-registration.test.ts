import { readFileSync } from "node:fs"
import {
  PAGE_LINK_TTL_MAX_HOURS,
  PAGE_LINK_TTL_MIN_HOURS,
} from "@chatbotx.io/database/partials"
import {
  sendPageStepDefaultFn,
  sendPageStepSchema,
  stepTypes,
} from "@chatbotx.io/flow-config"
import { describe, expect, test } from "vitest"

describe("sendPage step registration (s227a)", () => {
  test("the step's TTL bounds are exactly the page model's", () => {
    const step = { ...sendPageStepDefaultFn(), pageId: "1" }
    const ok = (ttlHours: number) =>
      sendPageStepSchema.safeParse({ ...step, ttlHours }).success
    expect(ok(PAGE_LINK_TTL_MIN_HOURS)).toBe(true)
    expect(ok(PAGE_LINK_TTL_MAX_HOURS)).toBe(true)
    expect(ok(PAGE_LINK_TTL_MIN_HOURS - 1)).toBe(false)
    expect(ok(PAGE_LINK_TTL_MAX_HOURS + 1)).toBe(false)
  })

  test("is wired into the builder step registry and the Perform Action menu", () => {
    expect(stepTypes.enum.sendPage).toBe("sendPage")
    const registry = readFileSync(
      "src/features/flows/react-flow/steps/index.tsx",
      "utf8",
    )
    expect(registry).toContain('import { sendPageStep } from "./send-page"')
    expect(registry).toContain("[stepTypes.enum.sendPage]: sendPageStep")
    const menu = readFileSync(
      "src/features/flows/react-flow/nodes/perform-action/menu.tsx",
      "utf8",
    )
    expect(menu).toContain("stepType: stepTypes.enum.sendPage")
  })

  test("has a worker handler (an unhandled step would be skipped as success)", () => {
    const handlers = readFileSync(
      "../worker/src/integration/handlers/step.ts",
      "utf8",
    )
    expect(handlers).toContain("[stepTypes.enum.sendPage]: handleSendPage")
  })
})
