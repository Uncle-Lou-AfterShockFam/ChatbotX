import { describe, expect, test } from "vitest"
import {
  compareFormValue,
  evaluateForm,
  type FormDefinition,
  formDefinition,
  pruneFormValues,
  validateFormSubmission,
} from "../src/form"

const def = (): FormDefinition =>
  formDefinition.parse({
    steps: [
      {
        id: "s1",
        fields: [
          {
            key: "interest",
            type: "select",
            options: [
              { value: "none", label: "None" },
              { value: "other", label: "Other" },
            ],
          },
          {
            key: "other",
            type: "text",
            visibleWhen: {
              logic: "AND",
              rules: [{ fieldKey: "interest", op: "eq", value: "other" }],
            },
          },
          { key: "age", type: "number", min: 18 },
          { key: "email", type: "email", required: true },
          {
            key: "tags",
            type: "checkboxGroup",
            options: [
              { value: "a", label: "A" },
              { value: "b", label: "B" },
            ],
          },
          { key: "agree", type: "checkbox" },
        ],
      },
      {
        id: "s2",
        visibleWhen: {
          logic: "AND",
          rules: [{ fieldKey: "interest", op: "neq", value: "none" }],
        },
        fields: [
          { key: "notes", type: "textarea", required: true },
          { key: "site", type: "url" },
        ],
      },
      { id: "s3", fields: [{ key: "done", type: "text" }] },
    ],
    rules: [
      {
        id: "r1",
        when: {
          logic: "AND",
          rules: [{ fieldKey: "interest", op: "eq", value: "other" }],
        },
        action: { type: "require", fieldKey: "other" },
      },
      {
        id: "r2",
        when: {
          logic: "AND",
          rules: [{ fieldKey: "interest", op: "eq", value: "none" }],
        },
        action: { type: "skip_to_step", fromStepId: "s1", toStepId: "s3" },
      },
    ],
  })

describe("compareFormValue", () => {
  test.each([
    ["eq", "Other", "other", true],
    ["neq", "a", "b", true],
    ["gt", "10", 9, true],
    ["gt", "abc", 9, false],
    ["gte", 9, "9", true],
    ["lt", "1", "2", true],
    ["lte", "3", "2", false],
    ["contains", "Hello World", "world", true],
    ["not_contains", "Hello", "z", true],
    ["contains", ["a", "b"], "B", true],
    ["starts_with", "Hello", "he", true],
    ["ends_with", "Hello", "LO", true],
    ["is_empty", "", undefined, true],
    ["is_empty", [], undefined, true],
    ["is_not_empty", "x", undefined, true],
    ["eq", true, "true", true],
    ["eq", ["a"], "a", true],
  ] as const)("%s(%j, %j) -> %s", (op, actual, expected, out) => {
    expect(compareFormValue(op, actual, expected)).toBe(out)
  })

  test("NaN never compares true and an unknown op is false", () => {
    expect(compareFormValue("gt", Number.NaN, 1)).toBe(false)
    expect(compareFormValue("lt", "x", "y")).toBe(false)
    expect(compareFormValue("bogus" as never, "a", "a")).toBe(false)
  })
})

describe("hostile values never throw (blind probe, s200)", () => {
  test("list fields with non-string elements, null-proto objects, symbols", () => {
    const d = def()
    d.steps[0].fields[1].visibleWhen = {
      logic: "AND",
      rules: [{ fieldKey: "tags", op: "contains", value: "a" }],
    }
    // `tags` comes before `other`? No: reorder so tags is read by a later field.
    const later = formDefinition.parse({
      steps: [
        {
          id: "s1",
          fields: [
            {
              key: "t",
              type: "checkboxGroup",
              options: [{ value: "a", label: "A" }],
            },
            {
              key: "u",
              type: "text",
              visibleWhen: {
                logic: "AND",
                rules: [{ fieldKey: "t", op: "contains", value: "a" }],
              },
            },
          ],
        },
      ],
      rules: [],
    })
    for (const values of [
      { t: [1] },
      { t: [null] },
      { t: [{ x: 1 }] },
      { t: Object.create(null) },
      { t: [Symbol("s")] },
      { t: 10n },
      { t: new Date() },
      { t: () => 1 },
    ] as unknown as Record<string, never>[]) {
      expect(() => evaluateForm(later, values)).not.toThrow()
      expect(() => validateFormSubmission(later, values)).not.toThrow()
    }
    expect(validateFormSubmission(later, { t: [1] } as never)).toContainEqual({
      key: "t",
      code: "type",
    })
  })

  test("compareFormValue never throws on any (op, actual, expected)", () => {
    const actuals = [
      null,
      undefined,
      "",
      "x",
      1,
      Number.NaN,
      true,
      [1, "a", null],
      Object.create(null),
      Symbol("s"),
      5n,
      new Date(0),
      () => 1,
    ]
    const expecteds = ["a", 1, true, undefined]
    for (const op of [
      "eq",
      "neq",
      "gt",
      "gte",
      "lt",
      "lte",
      "contains",
      "not_contains",
      "starts_with",
      "ends_with",
      "is_empty",
      "is_not_empty",
    ] as const) {
      for (const a of actuals) {
        for (const e of expecteds) {
          expect(
            () => compareFormValue(op, a as never, e),
            `${op}`,
          ).not.toThrow()
        }
      }
    }
  })

  test("a field keyed `constructor` reads only own properties", () => {
    const d = formDefinition.parse({
      steps: [{ id: "s1", fields: [{ key: "constructor", type: "text" }] }],
      rules: [],
    })
    expect(validateFormSubmission(d, {})).toEqual([])
    expect(pruneFormValues(d, {}, evaluateForm(d, {}))).toEqual({})
    expect(
      pruneFormValues(
        d,
        { constructor: "x" },
        evaluateForm(d, { constructor: "x" }),
      ),
    ).toEqual({ constructor: "x" })
  })
})

describe("evaluateForm", () => {
  test("a field's own condition shows it and a rule requires it", () => {
    const e = evaluateForm(def(), { interest: "other" })
    expect(e.visibleFields.has("other")).toBe(true)
    expect(e.requiredFields.has("other")).toBe(true)
    expect(e.visibleSteps.has("s2")).toBe(true)
  })

  test("a hidden step clamps its fields and skip_to_step is recorded", () => {
    const e = evaluateForm(def(), { interest: "none" })
    expect(e.visibleSteps.has("s2")).toBe(false)
    expect(e.visibleFields.has("notes")).toBe(false)
    expect(e.visibleFields.has("other")).toBe(false)
    expect(e.skipMap.get("s1")).toBe("s3")
  })

  test("hide beats show; require beats optional; a hidden step beats a show rule", () => {
    const d = def()
    d.rules.push(
      {
        id: "show",
        when: { logic: "AND", rules: [] },
        action: { type: "show", fieldKey: "notes" },
      },
      {
        id: "hide",
        when: { logic: "AND", rules: [] },
        action: { type: "hide", fieldKey: "age" },
      },
      {
        id: "showage",
        when: { logic: "AND", rules: [] },
        action: { type: "show", fieldKey: "age" },
      },
      {
        id: "opt",
        when: { logic: "AND", rules: [] },
        action: { type: "optional", fieldKey: "email" },
      },
      {
        id: "req",
        when: { logic: "AND", rules: [] },
        action: { type: "require", fieldKey: "email" },
      },
    )
    const e = evaluateForm(d, { interest: "none" })
    expect(e.visibleFields.has("notes")).toBe(false)
    expect(e.visibleFields.has("age")).toBe(false)
    expect(e.requiredFields.has("email")).toBe(true)
  })

  test("a condition reading a hidden field sees undefined", () => {
    const d = def()
    d.rules.push({
      id: "r3",
      when: { logic: "AND", rules: [{ fieldKey: "other", op: "is_empty" }] },
      action: { type: "hide", fieldKey: "done" },
    })
    // `other` is hidden (interest=none) even though a stale answer is present.
    const e = evaluateForm(d, { interest: "none", other: "stale" })
    expect(e.visibleFields.has("done")).toBe(false)
  })

  test("an empty group is always true and OR needs one hit", () => {
    const d = def()
    d.steps[2].visibleWhen = {
      logic: "OR",
      rules: [
        { fieldKey: "interest", op: "eq", value: "zzz" },
        { fieldKey: "age", op: "gte", value: 18 },
      ],
    }
    expect(evaluateForm(d, { age: "17" }).visibleSteps.has("s3")).toBe(false)
    expect(evaluateForm(d, { age: "18" }).visibleSteps.has("s3")).toBe(true)
  })
})

describe("validateFormSubmission", () => {
  test("required visible field missing -> required; hidden fields are skipped", () => {
    const issues = validateFormSubmission(def(), { interest: "none" })
    expect(issues).toEqual([{ key: "email", code: "required" }])
    // `other` is required by rule only when visible
    const issues2 = validateFormSubmission(def(), {
      interest: "other",
      email: "a@b.co",
      notes: "x",
    })
    expect(issues2).toEqual([{ key: "other", code: "required" }])
  })

  test.each([
    [{ interest: "nope" }, "interest", "option"],
    [{ interest: 5 }, "interest", "type"],
    [{ age: "17" }, "age", "min"],
    [{ age: "x" }, "age", "number"],
    [{ email: "nope" }, "email", "email"],
    [{ tags: ["a", "z"] }, "tags", "option"],
    [{ tags: "a" }, "tags", "type"],
    [{ agree: "yes" }, "agree", "type"],
    [
      { interest: "other", email: "a@b.co", notes: "n", site: "javascript:1" },
      "site",
      "url",
    ],
    [{ email: "x".repeat(2001) }, "email", "length"],
  ] as const)("%j -> %s %s", (values, key, code) => {
    const issues = validateFormSubmission(def(), {
      email: "ok@x.io",
      ...values,
    })
    expect(issues).toContainEqual({ key, code })
  })

  test("a clean submission has no issues", () => {
    expect(
      validateFormSubmission(def(), {
        interest: "other",
        other: "yes",
        age: 30,
        email: "a@b.co",
        tags: ["a"],
        agree: true,
        notes: "hi",
        site: "https://x.io",
      }),
    ).toEqual([])
  })
})

describe("pruneFormValues", () => {
  test("drops unknown keys, hidden fields and blanks", () => {
    const d = def()
    const values = {
      interest: "none",
      other: "stale",
      notes: "hidden step",
      bogus: "x",
      email: "",
      done: "keep",
    }
    const pruned = pruneFormValues(d, values, evaluateForm(d, values))
    expect(pruned).toEqual({ interest: "none", done: "keep" })
  })
})
