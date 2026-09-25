// @vitest-environment node

import { type FormDefinition, formDefinition } from "@chatbotx.io/utils/form"
import { describe, expect, test } from "vitest"
import {
  addField,
  addStep,
  moveField,
  moveStep,
  newField,
  removeField,
  removeStep,
  renameFieldKey,
  uniqueFieldKey,
} from "../src/features/forms/lib/editor-ops"

const base = (): FormDefinition =>
  formDefinition.parse({
    steps: [
      {
        id: "s1",
        fields: [
          {
            key: "interest",
            type: "select",
            options: [{ value: "a", label: "A" }],
          },
          {
            key: "other",
            type: "text",
            visibleWhen: {
              logic: "AND",
              rules: [{ fieldKey: "interest", op: "eq", value: "a" }],
            },
          },
        ],
      },
      { id: "s2", fields: [{ key: "notes", type: "textarea" }] },
      { id: "s3", fields: [] },
    ],
    rules: [
      {
        id: "r1",
        when: {
          logic: "AND",
          rules: [{ fieldKey: "interest", op: "eq", value: "a" }],
        },
        action: { type: "require", fieldKey: "other" },
      },
      {
        id: "r2",
        when: { logic: "AND", rules: [] },
        action: { type: "skip_to_step", fromStepId: "s1", toStepId: "s3" },
      },
    ],
  })

/** Every op must leave the result parseable by the strict schema. */
const valid = (def: FormDefinition) =>
  expect(formDefinition.safeParse(def).success).toBe(true)

describe("editor ops (s200)", () => {
  test("uniqueFieldKey slugifies and de-duplicates", () => {
    const def = base()
    expect(uniqueFieldKey(def, "First name")).toBe("first_name")
    expect(uniqueFieldKey(def, "Interest")).toBe("interest_2")
    expect(uniqueFieldKey(def, "123")).toBe("f_123")
    expect(uniqueFieldKey(def, "!!!")).toBe("field")
    expect(uniqueFieldKey(def, "x".repeat(80)).length).toBeLessThanOrEqual(40)
  })

  test("newField gives option types two options; addField respects the cap", () => {
    const def = base()
    const f = newField(def, "radio", "Pick")
    expect(f.options).toHaveLength(2)
    const next = addField(def, "s3", f)
    expect(next.steps[2].fields[0].key).toBe("pick")
    valid(next)
    expect(def.steps[2].fields).toHaveLength(0) // input untouched
  })

  test("removeField drops the conditions and rules that read or target it", () => {
    const next = removeField(base(), "interest")
    expect(next.steps[0].fields.map((f) => f.key)).toEqual(["other"])
    expect(next.steps[0].fields[0].visibleWhen?.rules).toEqual([])
    expect(next.rules.find((r) => r.id === "r1")?.when.rules).toEqual([])
    valid(next)
    const dropped = removeField(base(), "other")
    expect(dropped.rules.map((r) => r.id)).toEqual(["r2"])
    valid(dropped)
  })

  test("renameFieldKey rewrites every reference and refuses collisions", () => {
    const next = renameFieldKey(base(), "interest", "topic")
    expect(next.steps[0].fields[0].key).toBe("topic")
    expect(JSON.stringify(next)).not.toContain('"interest"')
    valid(next)
    const clash = base()
    expect(renameFieldKey(clash, "interest", "notes")).toBe(clash)
    const same = base()
    expect(renameFieldKey(same, "interest", "Bad Key")).toBe(same)
  })

  test("removeStep drops its fields' references and skip rules naming it", () => {
    const next = removeStep(base(), "s3")
    expect(next.steps.map((s) => s.id)).toEqual(["s1", "s2"])
    expect(next.rules.map((r) => r.id)).toEqual(["r1"])
    valid(next)
    const first = removeStep(base(), "s1")
    expect(first.rules).toEqual([])
    valid(first)
  })

  test("moveStep drops a skip rule that would point backwards", () => {
    const next = moveStep(base(), 2, 0)
    expect(next.steps.map((s) => s.id)).toEqual(["s3", "s1", "s2"])
    expect(next.rules.map((r) => r.id)).toEqual(["r1"])
    valid(next)
    const noop = base()
    expect(moveStep(noop, 0, 9)).toBe(noop)
  })

  test("moveField reorders inside a step and ignores bad indexes", () => {
    const next = moveField(base(), "s1", 0, 1)
    expect(next.steps[0].fields.map((f) => f.key)).toEqual([
      "other",
      "interest",
    ])
    valid(next)
    const same = base()
    expect(moveField(same, "s1", 0, 5)).toBe(same)
  })

  test("addStep stops at the cap", () => {
    let def = base()
    for (let i = 0; i < 30; i++) {
      def = addStep(def)
    }
    expect(def.steps).toHaveLength(20)
    valid(def)
  })
})
