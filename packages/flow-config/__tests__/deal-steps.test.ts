import { describe, expect, test } from "vitest"
import { actionSteps, stepTypes } from "../src"
import {
  createDealPriorities,
  createDealStepDefaultFn,
  createDealStepSchema,
} from "../src/steps/create-deal"
import {
  moveDealStageStepDefaultFn,
  moveDealStageStepSchema,
} from "../src/steps/move-deal-stage"
import {
  setDealStatusStepDefaultFn,
  setDealStatusStepSchema,
} from "../src/steps/set-deal-status"

describe("deal steps", () => {
  test("the three step types are registered in actionSteps", () => {
    for (const fn of [
      createDealStepDefaultFn,
      moveDealStageStepDefaultFn,
      setDealStatusStepDefaultFn,
    ]) {
      const value = fn()
      expect(
        actionSteps.some((schema) => schema.safeParse(value).success),
      ).toBe(true)
    }
    expect(stepTypes.options).toEqual(
      expect.arrayContaining(["createDeal", "moveDealStage", "setDealStatus"]),
    )
  })

  test("createDeal priorities mirror dealPriorities in @chatbotx.io/database/partials (that package depends on this one)", () => {
    expect(createDealPriorities.options).toEqual(["low", "medium", "high"])
  })

  test("createDeal defaults: skipIfOpenDealExists on, medium priority, empty title/value", () => {
    const step = createDealStepDefaultFn()
    expect(step).toMatchObject({
      title: "",
      value: "",
      currency: "",
      priority: "medium",
      skipIfOpenDealExists: true,
    })
    const { title: _t, value: _v, skipIfOpenDealExists: _s, ...legacy } = step
    expect(createDealStepSchema.parse(legacy)).toMatchObject({
      title: "",
      value: "",
      skipIfOpenDealExists: true,
    })
  })

  test.each([
    [{ priority: "urgent" }, "unknown priority"],
    [{ title: "x".repeat(201) }, "title too long"],
    [{ currency: "EURO" }, "4-letter currency"],
    [{ skipIfOpenDealExists: "no" }, "non-boolean skip"],
    [{ id: 12 }, "numeric id"],
  ])("createDeal rejects %j (%s)", (patch) => {
    expect(
      createDealStepSchema.safeParse({ ...createDealStepDefaultFn(), ...patch })
        .success,
    ).toBe(false)
  })

  test("createDeal keeps {{variable}} tokens in title and value", () => {
    const step = createDealStepSchema.parse({
      ...createDealStepDefaultFn(),
      title: "Deal for {{contact.full_name}}",
      value: "{{contact.custom_field.budget}}",
    })
    expect(step.title).toContain("{{contact.full_name}}")
    expect(step.value).toBe("{{contact.custom_field.budget}}")
  })

  test("setDealStatus only targets won or lost; moveDealStage carries pipeline + stage", () => {
    expect(
      setDealStatusStepSchema.safeParse({
        ...setDealStatusStepDefaultFn(),
        status: "open",
      }).success,
    ).toBe(false)
    expect(setDealStatusStepDefaultFn().status).toBe("won")
    expect(
      moveDealStageStepSchema.parse({
        ...moveDealStageStepDefaultFn(),
        pipelineId: "p",
        stageId: "s",
      }),
    ).toMatchObject({ pipelineId: "p", stageId: "s" })
  })
})
