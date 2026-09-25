import { describe, expect, test } from "vitest"
import { actionSteps, stepTypes } from "../src"
import { REFERENCE_FIELD_ENTITY_KIND } from "../src/import-export/reference-fields"
import {
  completeTaskStepDefaultFn,
  completeTaskStepSchema,
} from "../src/steps/complete-task"
import {
  createTaskAssignTo,
  createTaskStepDefaultFn,
  createTaskStepSchema,
} from "../src/steps/create-task"

describe("deal task steps (s192)", () => {
  test("both step types are registered in actionSteps", () => {
    for (const fn of [createTaskStepDefaultFn, completeTaskStepDefaultFn]) {
      expect(actionSteps.some((s) => s.safeParse(fn()).success)).toBe(true)
    }
    expect(stepTypes.options).toEqual(
      expect.arrayContaining(["createTask", "completeTask"]),
    )
  })

  test("createTask defaults + bounds; assignTo mirrors dealTaskAssignTo", () => {
    const step = createTaskStepDefaultFn()
    expect(step).toMatchObject({ title: "", dueInDays: null, assignTo: "none" })
    expect(createTaskAssignTo.options).toEqual(["none", "dealOwner", "user"])
    for (const bad of [-1, 366, 1.5, "7"]) {
      expect(
        createTaskStepSchema.safeParse({ ...step, dueInDays: bad }).success,
      ).toBe(false)
    }
    expect(
      createTaskStepSchema.safeParse({ ...step, title: "x".repeat(201) })
        .success,
    ).toBe(false)
    expect(
      createTaskStepSchema.safeParse({ ...step, assignTo: "team" }).success,
    ).toBe(false)
    expect(
      createTaskStepSchema.parse({
        ...step,
        assignTo: "user",
        assigneeId: "u1",
        dueInDays: 3,
      }),
    ).toMatchObject({ assigneeId: "u1", dueInDays: 3 })
  })

  test("createTask startInDays (s197): bounded like dueInDays, never after it", () => {
    const step = createTaskStepDefaultFn()
    expect(step.startInDays).toBeNull()
    for (const bad of [-1, 366, 1.5]) {
      expect(
        createTaskStepSchema.safeParse({ ...step, startInDays: bad }).success,
      ).toBe(false)
    }
    const after = createTaskStepSchema.safeParse({
      ...step,
      startInDays: 5,
      dueInDays: 2,
    })
    expect(after.success).toBe(false)
    expect(after.error?.issues[0]?.path).toEqual(["startInDays"])
    expect(
      createTaskStepSchema.parse({ ...step, startInDays: 2, dueInDays: 2 }),
    ).toMatchObject({ startInDays: 2, dueInDays: 2 })
    // a start with no due date is fine
    expect(
      createTaskStepSchema.safeParse({ ...step, startInDays: 9 }).success,
    ).toBe(true)
    // still a registered action step after the refinement
    expect(
      actionSteps.some((s) => s.safeParse({ ...step, startInDays: 1 }).success),
    ).toBe(true)
  })

  test("completeTask matches by template (default) or title", () => {
    const step = completeTaskStepDefaultFn()
    expect(step.match).toBe("template")
    expect(
      completeTaskStepSchema.safeParse({ ...step, match: "id" }).success,
    ).toBe(false)
    expect(
      completeTaskStepSchema.parse({
        ...step,
        match: "title",
        title: " Call back ",
      }).title,
    ).toBe("Call back")
  })

  test("templateId is a reference field (export warns); assigneeId is not (users are not exportable)", () => {
    expect(REFERENCE_FIELD_ENTITY_KIND.templateId).toBe("dealTaskTemplate")
    expect(REFERENCE_FIELD_ENTITY_KIND.assigneeId).toBeUndefined()
  })
})
