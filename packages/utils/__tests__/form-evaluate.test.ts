import { describe, expect, test } from "vitest"
import {
  applyHiddenDefaults,
  compareFormValue,
  evaluateForm,
  type FormDefinition,
  type FormDefinitionInput,
  formDefinition,
  formScaleBounds,
  formScore,
  isBlockedEmailDomain,
  parseFormChatAnswer,
  pruneFormValues,
  validateFormField,
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

// s220c A2-4: a hidden field's value is the form's, never the visitor's.
describe("applyHiddenDefaults", () => {
  const hd = formDefinition.parse({
    steps: [
      {
        id: "s1",
        fields: [
          { key: "name", type: "text", label: "Name" },
          {
            key: "source",
            type: "hidden",
            label: "",
            defaultValue: "landing-a",
          },
          { key: "ref", type: "hidden", label: "" },
          { key: "campaign", type: "hidden", label: "", defaultValue: "none" },
        ],
      },
    ],
    rules: [
      {
        id: "r1",
        when: {
          logic: "AND",
          rules: [{ fieldKey: "source", op: "eq", value: "landing-a" }],
        },
        action: { type: "require", fieldKey: "name" },
      },
    ],
  })

  test("sets every hidden default, overwrites a sent value, drops a hidden field with no default", () => {
    expect(
      applyHiddenDefaults(hd, { name: "Ada", source: "evil", ref: "x" }),
    ).toEqual({
      name: "Ada",
      source: "landing-a",
      campaign: "none",
    })
  })

  test("a prefillable key keeps a sent value; empty / missing falls back to the default", () => {
    const keep = new Set(["campaign", "ref"])
    expect(
      applyHiddenDefaults(hd, { campaign: "fall", ref: "r9" }, keep),
    ).toMatchObject({ campaign: "fall", ref: "r9" })
    expect(applyHiddenDefaults(hd, { campaign: "" }, keep)).toMatchObject({
      campaign: "none",
    })
    expect(applyHiddenDefaults(hd, {}, keep)).not.toHaveProperty("ref")
  })

  test("never mutates the input; non-hidden fields and unknown keys pass through untouched", () => {
    const input = { name: "Ada", source: "evil", extra: 1 }
    const out = applyHiddenDefaults(hd, input)
    expect(input).toEqual({ name: "Ada", source: "evil", extra: 1 })
    expect(out).toMatchObject({ name: "Ada", extra: 1 })
  })

  test("rules read the default (a required-when-source rule fires with no source sent)", () => {
    const values = applyHiddenDefaults(hd, {})
    const issues = validateFormSubmission(hd, values, evaluateForm(hd, values))
    expect(issues).toEqual([{ key: "name", code: "required" }])
  })

  test("a hidden field that identifies the contact cannot carry a default (every submitter would collapse onto one contact)", () => {
    const hiddenIdentity = (
      key: "email" | "phoneNumber",
      defaultValue?: string,
    ) =>
      formDefinition.safeParse({
        steps: [
          {
            id: "s1",
            fields: [
              {
                key: "who",
                type: "hidden",
                label: "",
                mapTo: { kind: "system", key },
                defaultValue,
              },
            ],
          },
        ],
        rules: [],
      })
    for (const key of ["email", "phoneNumber"] as const) {
      const r = hiddenIdentity(key, "fixed@example.com")
      expect(r.success).toBe(false)
      expect(r.error?.issues.map((i) => i.path.at(-1))).toContain(
        "defaultValue",
      )
      // without a default (a link fills it) it stays valid
      expect(hiddenIdentity(key).success).toBe(true)
      expect(hiddenIdentity(key, "").success).toBe(true)
    }
  })

  test("hostile shapes: an array / object sent for a hidden key is replaced, never thrown on", () => {
    const hostile = { source: ["a", "b"], campaign: { $ne: 1 } } as never
    expect(applyHiddenDefaults(hd, hostile)).toEqual({
      source: "landing-a",
      campaign: "none",
    })
    expect(
      applyHiddenDefaults(
        formDefinition.parse({ steps: [{ id: "s", fields: [] }], rules: [] }),
        hostile,
      ),
    ).toEqual(hostile)
  })
})

// s219 A2-1: scoring and the chat-only answer types.
const chatOne = (field: Record<string, unknown>): FormDefinitionInput => ({
  steps: [{ id: "s1", fields: [field as never] }],
  rules: [],
})

describe("option points + formScore", () => {
  const scored: FormDefinitionInput = {
    steps: [
      {
        id: "s1",
        fields: [
          {
            key: "mood",
            type: "radio",
            options: [
              { value: "good", label: "Good", points: 3 },
              { value: "bad", label: "Bad", points: -1 },
            ],
          },
          {
            key: "tags",
            type: "checkboxGroup",
            options: [
              { value: "a", label: "A", points: 2 },
              { value: "b", label: "B", points: 5 },
              { value: "c", label: "C" },
            ],
            visibleWhen: {
              logic: "AND",
              rules: [{ fieldKey: "mood", op: "eq", value: "good" }],
            },
          },
        ],
      },
    ],
    rules: [],
  }

  test("sums the chosen options of VISIBLE fields only", () => {
    const def = formDefinition.parse(scored)
    expect(formScore(def, { mood: "good", tags: ["a", "b", "c"] })).toBe(10)
    // tags is hidden when mood is bad: its answer never scores
    expect(formScore(def, { mood: "bad", tags: ["a", "b"] })).toBe(-1)
    expect(formScore(def, {})).toBe(0)
  })

  test("an unscored form reports null, never 0", () => {
    const def = formDefinition.parse(
      chatOne({
        key: "q",
        type: "select",
        options: [{ value: "x", label: "X" }],
      }),
    )
    expect(formScore(def, { q: "x" })).toBeNull()
  })

  test("a score cannot be inflated by answers for unknown keys or unknown options", () => {
    const def = formDefinition.parse(scored)
    expect(
      formScore(def, {
        mood: "good",
        tags: ["a", "zzz", "a"],
        mood2: "good",
      } as never),
    ).toBe(5)
  })
})

describe("validation of chat answers", () => {
  const validate = (type: string, value: unknown) => {
    const def = formDefinition.parse(chatOne({ key: "q", type }))
    return validateFormSubmission(
      def,
      { q: value as never },
      evaluateForm(def, { q: value as never }),
    )
  }

  test.each([
    ["image", "https://storage.example.com/a.png"],
    ["file", "http://localhost:9000/space/1/x.pdf"],
    ["location", "39.95,-75.16"],
    ["location", "-90, 180"],
    ["location", "0,0"],
  ])("%s accepts %s", (type, value) => {
    expect(validate(type, value)).toEqual([])
  })

  test.each([
    ["image", "not a url", "url"],
    ["file", "javascript:alert(1)", "url"],
    ["image", ["https://a.example/x.png"], "type"],
    ["location", "91,0", "location"],
    ["location", "0,181", "location"],
    ["location", "39.95", "location"],
    ["location", "north pole", "location"],
    ["location", "1e2,3", "location"],
    ["location", `${"1".repeat(3000)},0`, "length"],
  ])("%s refuses %j with %s", (type, value, code) => {
    expect(validate(type, value)).toEqual([{ key: "q", code }])
  })
})

// s220c A2-4: blocked email domains.
describe("isBlockedEmailDomain + validateFormSubmission", () => {
  test("the domain and its subdomains are blocked, a lookalike is not", () => {
    const blocked = ["example.com"]
    expect(isBlockedEmailDomain("a@example.com", blocked)).toBe(true)
    expect(isBlockedEmailDomain("a@MAIL.Example.com", blocked)).toBe(true)
    expect(isBlockedEmailDomain("a@example.com.", blocked)).toBe(true)
    expect(isBlockedEmailDomain("a@notexample.com", blocked)).toBe(false)
    expect(isBlockedEmailDomain("a@example.co", blocked)).toBe(false)
    // the LAST @ decides: a quoted local part cannot smuggle a domain
    expect(isBlockedEmailDomain('"x@example.com"@ok.org', blocked)).toBe(false)
  })

  test("never throws on a hostile value; an empty list blocks nothing", () => {
    for (const v of [
      null,
      undefined,
      42,
      ["a@example.com"],
      { a: 1 },
      "",
      "@example.com",
      "no-at",
    ]) {
      expect(isBlockedEmailDomain(v, ["example.com"])).toBe(false)
    }
    expect(isBlockedEmailDomain("a@example.com", [])).toBe(false)
  })

  test("only email-type fields get emailDomainBlocked; an invalid email keeps its own code", () => {
    const d = formDefinition.parse({
      steps: [
        {
          id: "s1",
          fields: [
            { key: "mail", type: "email", label: "Email" },
            { key: "note", type: "text", label: "Note" },
          ],
        },
      ],
      rules: [],
    })
    const opts = { blockedEmailDomains: ["example.com"] }
    const check = (values: Record<string, string>) =>
      validateFormSubmission(d, values, evaluateForm(d, values), opts)
    expect(check({ mail: "a@example.com", note: "b@example.com" })).toEqual([
      { key: "mail", code: "emailDomainBlocked" },
    ])
    expect(check({ mail: "not-an-email" })).toEqual([
      { key: "mail", code: "email" },
    ])
    expect(check({ mail: "a@ok.org" })).toEqual([])
    // without the option nothing is blocked (the chat finish passes none)
    expect(validateFormSubmission(d, { mail: "a@example.com" })).toEqual([])
  })
})

describe("blocked domains on an email-identity text field (skeptic s220c bypass)", () => {
  test("a TEXT field that fills the contact's email is checked too; a plain text field is not", () => {
    const d = formDefinition.parse({
      steps: [
        {
          id: "s1",
          fields: [
            {
              key: "addr",
              type: "text",
              label: "Email",
              mapTo: { kind: "system", key: "email" },
            },
            { key: "other", type: "text", label: "Other" },
          ],
        },
      ],
      rules: [],
    })
    const values = { addr: "spam@example.com", other: "spam@example.com" }
    expect(
      validateFormSubmission(d, values, evaluateForm(d, values), {
        blockedEmailDomains: ["example.com"],
      }),
    ).toEqual([{ key: "addr", code: "emailDomainBlocked" }])
  })
})

// s220c A2-4: slider + rating.
describe("slider + rating", () => {
  const one = (field: Record<string, unknown>) =>
    formDefinition.safeParse({
      steps: [{ id: "s1", fields: [field] }],
      rules: [],
    })

  test("schema: a slider needs min AND max, a step within its range; step is slider-only", () => {
    expect(one({ key: "s", type: "slider", label: "S" }).success).toBe(false)
    expect(one({ key: "s", type: "slider", label: "S", min: 0 }).success).toBe(
      false,
    )
    expect(
      one({ key: "s", type: "slider", label: "S", min: 0, max: 10 }).success,
    ).toBe(true)
    expect(
      one({ key: "s", type: "slider", label: "S", min: 0, max: 10, step: 20 })
        .success,
    ).toBe(false)
    expect(
      one({ key: "s", type: "slider", label: "S", min: 0, max: 10, step: 0 })
        .success,
    ).toBe(false)
    expect(one({ key: "n", type: "number", label: "N", step: 2 }).success).toBe(
      false,
    )
  })

  test("schema: a rating starts at 1, has 3..10 stars, no default; neither maps to a system field", () => {
    expect(one({ key: "r", type: "rating", label: "R" }).success).toBe(true)
    expect(one({ key: "r", type: "rating", label: "R", max: 10 }).success).toBe(
      true,
    )
    for (const bad of [
      { max: 2 },
      { max: 11 },
      { max: 4.5 },
      { min: 1 },
      { defaultValue: "3" },
    ]) {
      expect(
        one({ key: "r", type: "rating", label: "R", ...bad }).success,
      ).toBe(false)
    }
    expect(
      one({
        key: "r",
        type: "rating",
        label: "R",
        mapTo: { kind: "system", key: "email" },
      }).success,
    ).toBe(false)
    expect(
      one({
        key: "r",
        type: "rating",
        label: "R",
        mapTo: { kind: "custom", customFieldId: "7" },
      }).success,
    ).toBe(true)
  })

  test("validation: on the scale and on a step (float steps tolerated); rating is an integer 1..max", () => {
    const slider = {
      key: "s",
      type: "slider",
      label: "S",
      required: false,
      min: 0,
      max: 1,
      step: 0.1,
    } as never
    expect(validateFormField(slider, 0.3)).toBeNull() // 0.1 * 3 is 0.30000000000000004
    expect(validateFormField(slider, "0.7")).toBeNull()
    expect(validateFormField(slider, 0.35)).toBe("number")
    expect(validateFormField(slider, -0.1)).toBe("min")
    expect(validateFormField(slider, 1.1)).toBe("max")
    expect(validateFormField(slider, "abc")).toBe("number")
    const rating = {
      key: "r",
      type: "rating",
      label: "R",
      required: false,
    } as never
    expect(formScaleBounds(rating)).toEqual({ min: 1, max: 5, step: 1 })
    expect(validateFormField(rating, 5)).toBeNull()
    expect(validateFormField(rating, 0)).toBe("min")
    expect(validateFormField(rating, 6)).toBe("max")
    expect(validateFormField(rating, 2.5)).toBe("number")
  })

  test("hostile values never throw", () => {
    const rating = {
      key: "r",
      type: "rating",
      label: "R",
      required: false,
    } as never
    for (const v of [
      null,
      true,
      [],
      ["3"],
      { n: 3 },
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "1e400",
    ]) {
      expect(() => validateFormField(rating, v as never)).not.toThrow()
      expect(validateFormField(rating, v as never)).not.toBeNull()
    }
  })

  test("chat: a reply is read as a number (a comma decimal too) and checked", () => {
    const slider = {
      key: "s",
      type: "slider",
      label: "S",
      required: true,
      min: 0,
      max: 10,
      step: 0.5,
    } as never
    expect(parseFormChatAnswer(slider, "7,5")).toEqual({ ok: true, value: 7.5 })
    expect(parseFormChatAnswer(slider, "7.3")).toEqual({
      ok: false,
      code: "number",
    })
    const rating = {
      key: "r",
      type: "rating",
      label: "R",
      required: true,
      max: 3,
    } as never
    expect(parseFormChatAnswer(rating, " 3 ")).toEqual({ ok: true, value: 3 })
    expect(parseFormChatAnswer(rating, "4")).toEqual({ ok: false, code: "max" })
    expect(parseFormChatAnswer(rating, "three")).toEqual({
      ok: false,
      code: "number",
    })
  })
})
