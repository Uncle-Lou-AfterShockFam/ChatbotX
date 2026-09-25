import { describe, expect, test } from "vitest"
import {
  EMPTY_FORM_DEFINITION,
  type FormConditionGroup,
  type FormDefinitionInput,
  formConditionDepth,
  formConditionGroup,
  formDefinition,
  formIdentifiesContact,
  formMapsToContact,
  isSafeFormPattern,
  MAX_FORM_CONDITION_DEPTH,
  MAX_FORM_DEFINITION_BYTES,
  MAX_FORM_FIELDS_PER_STEP,
  MAX_FORM_OPTIONS,
  MAX_FORM_RULES,
  MAX_FORM_RULES_PER_GROUP,
  MAX_FORM_STEPS,
} from "../src/form"

const base = (): FormDefinitionInput => ({
  steps: [
    {
      id: "s1",
      title: "About you",
      fields: [
        { key: "first_name", type: "text", label: "First name" },
        {
          key: "interest",
          type: "select",
          label: "Interest",
          options: [
            { value: "none", label: "None" },
            { value: "other", label: "Other" },
          ],
        },
        {
          key: "other",
          type: "text",
          label: "Other",
          visibleWhen: {
            logic: "AND",
            rules: [{ fieldKey: "interest", op: "eq", value: "other" }],
          },
        },
        { key: "intro", type: "heading", label: "Hello" },
      ],
    },
    {
      id: "s2",
      title: "More",
      fields: [{ key: "notes", type: "textarea", label: "Notes" }],
    },
  ],
  rules: [],
})

/** A group nested `n` levels deep (n = 1 is a flat group). */
const nest = (n: number): FormConditionGroup =>
  n <= 1
    ? { logic: "AND", rules: [{ fieldKey: "interest", op: "is_empty" }] }
    : { logic: "OR", rules: [nest(n - 1)] }

describe("formDefinition", () => {
  test("parses a valid definition and defaults rules", () => {
    const parsed = formDefinition.parse(base())
    expect(parsed.rules).toEqual([])
    expect(parsed.steps[0].fields[0].required).toBe(false)
  })

  test.each([
    ["null", null],
    ["array", []],
    ["string", "steps"],
    ["missing steps", {}],
  ])("rejects %s", (_label, input) => {
    expect(formDefinition.safeParse(input).success).toBe(false)
  })

  test("rejects unknown top-level and field keys (closed schema)", () => {
    const d = base() as Record<string, unknown>
    d.extra = 1
    expect(formDefinition.safeParse(d).success).toBe(false)
    const e = base()
    ;(e.steps[0].fields[0] as Record<string, unknown>).bogus = true
    expect(formDefinition.safeParse(e).success).toBe(false)
  })

  test("rejects a duplicate field key across steps", () => {
    const d = base()
    d.steps[1].fields.push({ key: "first_name", type: "text" })
    const r = formDefinition.safeParse(d)
    expect(r.success).toBe(false)
    expect(JSON.stringify(r.error?.issues)).toContain("Duplicate field key")
  })

  test("rejects a duplicate step id", () => {
    const d = base()
    d.steps[1].id = "s1"
    expect(formDefinition.safeParse(d).success).toBe(false)
  })

  test("rejects a condition that reads a display block or a missing key", () => {
    const d = base()
    d.steps[0].fields[2].visibleWhen = {
      logic: "AND",
      rules: [{ fieldKey: "intro", op: "is_empty" }],
    }
    expect(formDefinition.safeParse(d).success).toBe(false)
    const e = base()
    e.steps[0].fields[2].visibleWhen = {
      logic: "AND",
      rules: [{ fieldKey: "nope", op: "is_empty" }],
    }
    expect(formDefinition.safeParse(e).success).toBe(false)
  })

  test("select without options / text with options are refused", () => {
    const d = base()
    d.steps[0].fields[1].options = []
    expect(formDefinition.safeParse(d).success).toBe(false)
    const e = base()
    e.steps[0].fields[0].options = [{ value: "a", label: "A" }]
    expect(formDefinition.safeParse(e).success).toBe(false)
  })

  test("duplicate option values are refused", () => {
    const d = base()
    d.steps[0].fields[1].options = [
      { value: "a", label: "A" },
      { value: "a", label: "A again" },
    ]
    expect(formDefinition.safeParse(d).success).toBe(false)
  })

  test("a display block cannot be required or mapped", () => {
    const d = base()
    d.steps[0].fields[3].required = true
    expect(formDefinition.safeParse(d).success).toBe(false)
    const e = base()
    e.steps[0].fields[3].mapTo = { kind: "system", key: "firstName" }
    expect(formDefinition.safeParse(e).success).toBe(false)
  })

  test("a system contact field may be mapped once; a custom field once", () => {
    const d = base()
    d.steps[0].fields[0].mapTo = { kind: "system", key: "email" }
    d.steps[1].fields[0].mapTo = { kind: "system", key: "email" }
    expect(formDefinition.safeParse(d).success).toBe(false)
    const e = base()
    e.steps[0].fields[0].mapTo = { kind: "custom", customFieldId: "9" }
    e.steps[1].fields[0].mapTo = { kind: "custom", customFieldId: "9" }
    expect(formDefinition.safeParse(e).success).toBe(false)
  })

  test("skip_to_step only jumps forward and only to real steps", () => {
    const when: FormConditionGroup = {
      logic: "AND",
      rules: [{ fieldKey: "interest", op: "eq", value: "none" }],
    }
    const back = base()
    back.rules = [
      {
        id: "r1",
        when,
        action: { type: "skip_to_step", fromStepId: "s2", toStepId: "s1" },
      },
    ]
    expect(formDefinition.safeParse(back).success).toBe(false)
    const same = base()
    same.rules = [
      {
        id: "r1",
        when,
        action: { type: "skip_to_step", fromStepId: "s1", toStepId: "s1" },
      },
    ]
    expect(formDefinition.safeParse(same).success).toBe(false)
    const ghost = base()
    ghost.rules = [
      {
        id: "r1",
        when,
        action: { type: "skip_to_step", fromStepId: "s1", toStepId: "s9" },
      },
    ]
    expect(formDefinition.safeParse(ghost).success).toBe(false)
    const ok = base()
    ok.rules = [
      {
        id: "r1",
        when,
        action: { type: "skip_to_step", fromStepId: "s1", toStepId: "s2" },
      },
    ]
    expect(formDefinition.safeParse(ok).success).toBe(true)
  })

  test("a rule targeting an unknown field is refused", () => {
    const d = base()
    d.rules = [
      {
        id: "r1",
        when: { logic: "AND", rules: [] },
        action: { type: "require", fieldKey: "ghost" },
      },
    ]
    expect(formDefinition.safeParse(d).success).toBe(false)
  })

  test("field key format is enforced", () => {
    for (const key of ["First", "1a", "a-b", "a".repeat(41), ""]) {
      const d = base()
      d.steps[0].fields[0].key = key
      expect(formDefinition.safeParse(d).success, key).toBe(false)
    }
  })

  test("a condition may only read EARLIER fields (a later read is always undefined)", () => {
    const d = base()
    // `other` (index 2) reading `notes` (step 2): later -> refused
    d.steps[0].fields[2].visibleWhen = {
      logic: "AND",
      rules: [{ fieldKey: "notes", op: "is_empty" }],
    }
    const r = formDefinition.safeParse(d)
    expect(r.success).toBe(false)
    expect(JSON.stringify(r.error?.issues)).toContain("comes later")
    // a field reading itself is also "not earlier"
    const e = base()
    e.steps[0].fields[0].visibleWhen = {
      logic: "AND",
      rules: [{ fieldKey: "first_name", op: "is_empty" }],
    }
    expect(formDefinition.safeParse(e).success).toBe(false)
    // a step condition may read only EARLIER steps
    const f = base()
    f.steps[1].visibleWhen = {
      logic: "AND",
      rules: [{ fieldKey: "notes", op: "is_empty" }],
    }
    expect(formDefinition.safeParse(f).success).toBe(false)
    f.steps[1].visibleWhen = {
      logic: "AND",
      rules: [{ fieldKey: "interest", op: "eq", value: "other" }],
    }
    expect(formDefinition.safeParse(f).success).toBe(true)
    // form-level rules run after visibility: any input field is fine
    const g = base()
    g.rules = [
      {
        id: "r1",
        when: {
          logic: "AND",
          rules: [{ fieldKey: "notes", op: "is_not_empty" }],
        },
        action: { type: "hide", fieldKey: "first_name" },
      },
    ]
    expect(formDefinition.safeParse(g).success).toBe(true)
  })

  test("customFieldId must be an int8 id (a `::bigint` cast on publish)", () => {
    for (const bad of ["abc", "1e5", "77; drop", "9".repeat(20), ""]) {
      const d = base()
      d.steps[0].fields[0].mapTo = { kind: "custom", customFieldId: bad }
      expect(formDefinition.safeParse(d).success, bad).toBe(false)
    }
    const ok = base()
    ok.steps[0].fields[0].mapTo = { kind: "custom", customFieldId: "77" }
    expect(formDefinition.safeParse(ok).success).toBe(true)
  })

  describe("pattern safety (ReDoS)", () => {
    test.each([
      ["(a+)+$", false],
      ["^(a|aa)+$", false],
      ["(\\d+)*x", false],
      ["(a)\\1", false],
      ["^[a-z0-9_-]{3,16}$", true],
      ["^\\d{5}(-\\d{4})?$", true],
      ["^(foo|bar)$", true],
      ["(ab)+c", true],
      ["(", false],
      ["a".repeat(201), false],
    ])("%s -> safe %s", (pattern, safe) => {
      expect(isSafeFormPattern(pattern)).toBe(safe)
      const d = base()
      d.steps[0].fields[0].pattern = pattern
      expect(formDefinition.safeParse(d).success).toBe(safe)
    })
  })

  test("an invalid pattern and min > max are refused", () => {
    const d = base()
    d.steps[0].fields[0].pattern = "("
    expect(formDefinition.safeParse(d).success).toBe(false)
    const e = base()
    e.steps[0].fields[0].min = 5
    e.steps[0].fields[0].max = 2
    expect(formDefinition.safeParse(e).success).toBe(false)
  })

  describe("caps", () => {
    test(`steps > ${MAX_FORM_STEPS}`, () => {
      const d = base()
      d.steps = Array.from({ length: MAX_FORM_STEPS + 1 }, (_, i) => ({
        id: `s${i}`,
        fields: [],
      }))
      expect(formDefinition.safeParse(d).success).toBe(false)
    })
    test(`fields per step > ${MAX_FORM_FIELDS_PER_STEP}`, () => {
      const d = base()
      d.steps[1].fields = Array.from(
        { length: MAX_FORM_FIELDS_PER_STEP + 1 },
        (_, i) => ({ key: `f${i}`, type: "text" as const }),
      )
      expect(formDefinition.safeParse(d).success).toBe(false)
    })
    test(`options > ${MAX_FORM_OPTIONS}`, () => {
      const d = base()
      d.steps[0].fields[1].options = Array.from(
        { length: MAX_FORM_OPTIONS + 1 },
        (_, i) => ({ value: `o${i}`, label: `O${i}` }),
      )
      expect(formDefinition.safeParse(d).success).toBe(false)
    })
    test(`rules > ${MAX_FORM_RULES}`, () => {
      const d = base()
      d.rules = Array.from({ length: MAX_FORM_RULES + 1 }, (_, i) => ({
        id: `r${i}`,
        when: { logic: "AND" as const, rules: [] },
        action: { type: "hide" as const, fieldKey: "notes" },
      }))
      expect(formDefinition.safeParse(d).success).toBe(false)
    })
    test(`rules per group > ${MAX_FORM_RULES_PER_GROUP}`, () => {
      const group: FormConditionGroup = {
        logic: "AND",
        rules: Array.from({ length: MAX_FORM_RULES_PER_GROUP + 1 }, () => ({
          fieldKey: "first_name",
          op: "is_empty" as const,
        })),
      }
      expect(formConditionGroup.safeParse(group).success).toBe(false)
    })
    test(`definition > ${MAX_FORM_DEFINITION_BYTES} bytes`, () => {
      const d = base()
      // 45 fields x 500-char help text = ~23 KB per step; three steps overflow.
      const fat = (p: string) =>
        Array.from({ length: 45 }, (_, i) => ({
          key: `${p}${i}`,
          type: "text" as const,
          helpText: "x".repeat(500),
        }))
      d.steps = [
        { id: "a", fields: fat("a") },
        { id: "b", fields: fat("b") },
        { id: "c", fields: fat("c") },
      ]
      const r = formDefinition.safeParse(d)
      expect(r.success).toBe(false)
      expect(JSON.stringify(r.error?.issues)).toContain("bytes")
    })
  })

  describe("condition depth cap", () => {
    test(`nesting ${MAX_FORM_CONDITION_DEPTH} deep parses`, () => {
      const group = nest(MAX_FORM_CONDITION_DEPTH)
      expect(formConditionDepth(group)).toBe(MAX_FORM_CONDITION_DEPTH)
      expect(formConditionGroup.safeParse(group).success).toBe(true)
      const d = base()
      d.steps[0].fields[2].visibleWhen = group
      expect(formDefinition.safeParse(d).success).toBe(true)
    })
    test("a 6000-deep body returns a failure, never a RangeError", () => {
      const group = nest(6000)
      expect(() => formConditionGroup.safeParse(group)).not.toThrow()
      expect(formConditionGroup.safeParse(group).success).toBe(false)
      const d = base()
      d.steps[0].fields[2].visibleWhen = group
      expect(() => formDefinition.safeParse(d)).not.toThrow()
      expect(formDefinition.safeParse(d).success).toBe(false)
    })

    test(`nesting ${MAX_FORM_CONDITION_DEPTH + 1} deep is refused`, () => {
      const group = nest(MAX_FORM_CONDITION_DEPTH + 1)
      const r = formConditionGroup.safeParse(group)
      expect(r.success).toBe(false)
      const d = base()
      d.steps[0].fields[2].visibleWhen = group
      expect(formDefinition.safeParse(d).success).toBe(false)
    })
  })

  test("formMapsToContact / formIdentifiesContact", () => {
    expect(formMapsToContact(EMPTY_FORM_DEFINITION)).toBe(false)
    const d = formDefinition.parse(base())
    expect(formMapsToContact(d)).toBe(false)
    expect(formIdentifiesContact(d)).toBe(false)
    const e = base()
    e.steps[0].fields[0].mapTo = { kind: "custom", customFieldId: "1" }
    const pe = formDefinition.parse(e)
    expect(formMapsToContact(pe)).toBe(true)
    expect(formIdentifiesContact(pe)).toBe(false)
    e.steps[1].fields[0].mapTo = { kind: "system", key: "phoneNumber" }
    expect(formIdentifiesContact(formDefinition.parse(e))).toBe(true)
  })
})
