import { readFileSync } from "node:fs"
import {
  delayTypeEventDefaultFn,
  stepTypes,
  waitStepDelayTypes,
  waitStepSchema,
} from "@chatbotx.io/flow-config"
import { describe, expect, test } from "vitest"

describe("wait step: event delay type registration", () => {
  test("the event variant parses with two exits", () => {
    const value = {
      id: "1",
      stepType: stepTypes.enum.wait,
      delayType: waitStepDelayTypes.enum.event,
      ...delayTypeEventDefaultFn(),
      tagId: "tag-1",
    }
    const parsed = waitStepSchema.safeParse(value)
    expect(parsed.success).toBe(true)
    expect(value.states.map((s) => s.stateType)).toEqual(["success", "skip"])
  })

  test("the builder offers it and renders its editor, viewer and handles", () => {
    const dir = "src/features/flows/react-flow/steps/wait"
    expect(
      readFileSync(`${dir}/components/delay-type-select.tsx`, "utf8"),
    ).toContain("waitStepDelayTypes.enum.event")
    expect(readFileSync(`${dir}/editor.tsx`, "utf8")).toContain(
      "<EventDelayEditor",
    )
    const viewer = readFileSync(`${dir}/viewer.tsx`, "utf8")
    expect(viewer).toContain("waitStepDelayTypes.enum.event")
    expect(viewer).toContain("<BaseStateViewer")
  })
})
