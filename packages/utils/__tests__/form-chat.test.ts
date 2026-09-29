import { describe, expect, test } from "vitest"
import {
  evaluateForm,
  type FormDefinition,
  type FormDefinitionInput,
  type FormField,
  formDefinition,
  formInputFields,
  formOptionsNumbered,
  formProfiledOutKeys,
  isFormChatSkip,
  matchFormOption,
  parseFormChatAnswer,
  planFormChat,
  pruneFormValues,
  validateFormField,
  validateFormSubmission,
} from "../src/form"

const NO_PROFILING_RULE = /no profiling rule/

const parse = (input: FormDefinitionInput): FormDefinition =>
  formDefinition.parse(input)

const color = {
  key: "color",
  type: "select",
  required: true,
  options: [
    { value: "red", label: "Red", points: 2 },
    { value: "blue", label: "Blue sky", points: 5 },
  ],
} as const

/** Intake: s1 (heading, name, color) -> s2 (email) -> s3 (notes); rule skips s2 on red. */
const intake = (): FormDefinition =>
  parse({
    steps: [
      {
        id: "s1",
        fields: [
          { key: "intro", type: "paragraph", label: "Welcome" },
          { key: "name", type: "text", required: true },
          color,
          { key: "ref", type: "hidden" },
        ],
      },
      {
        id: "s2",
        fields: [{ key: "email", type: "email", required: true }],
      },
      {
        id: "s3",
        fields: [
          { key: "divide", type: "divider" },
          { key: "notes", type: "textarea" },
        ],
      },
    ],
    rules: [
      {
        id: "r1",
        when: {
          logic: "AND",
          rules: [{ fieldKey: "color", op: "eq", value: "red" }],
        },
        action: { type: "skip_to_step", fromStepId: "s1", toStepId: "s3" },
      },
    ],
  })

const fieldOf = (def: FormDefinition, key: string): FormField => {
  const field = formInputFields(def).find((f) => f.key === key)
  if (!field) {
    throw new Error(`no field ${key}`)
  }
  return field
}

describe("evaluateForm: a skipped step is never reached (s219 A2-2)", () => {
  test("skip_to_step clamps the jumped step: its required field is neither visible nor required", () => {
    const e = evaluateForm(intake(), { name: "Ann", color: "red" })
    expect(e.visibleSteps.has("s2")).toBe(false)
    expect(e.visibleFields.has("email")).toBe(false)
    expect(e.requiredFields.has("email")).toBe(false)
    expect(e.skipMap.get("s1")).toBe("s3")
  })

  test("the web submit no longer demands a required field on a skipped step", () => {
    const def = intake()
    const values = { name: "Ann", color: "red" }
    expect(validateFormSubmission(def, values)).toEqual([])
  })

  test("an answer left on a skipped step is pruned, never persisted", () => {
    const def = intake()
    const values = { name: "Ann", color: "red", email: "a@b.co" }
    expect(pruneFormValues(def, values, evaluateForm(def, values))).toEqual({
      name: "Ann",
      color: "red",
    })
  })

  test("a skip decided by a field ON the jumped step never jumps, so its answer is never erased (skeptic)", () => {
    const def = parse({
      steps: [
        { id: "s1", fields: [{ key: "a", type: "text" }] },
        { id: "s2", fields: [{ key: "b", type: "text" }] },
        { id: "s3", fields: [{ key: "c", type: "text" }] },
      ],
      rules: [
        {
          id: "r1",
          when: {
            logic: "AND",
            rules: [{ fieldKey: "b", op: "eq", value: "hidden" }],
          },
          action: { type: "skip_to_step", fromStepId: "s1", toStepId: "s3" },
        },
      ],
    })
    const values = { a: "x", b: "hidden", c: "y" }
    const e = evaluateForm(def, values)
    expect(e.skipMap.size).toBe(0)
    expect([...e.visibleFields]).toEqual(["a", "b", "c"])
    expect(pruneFormValues(def, values, e)).toEqual(values)
  })

  test("without the jump every step stays reached", () => {
    const e = evaluateForm(intake(), { name: "Ann", color: "blue" })
    expect([...e.visibleSteps]).toEqual(["s1", "s2", "s3"])
    expect(e.requiredFields.has("email")).toBe(true)
  })
})

describe("validateFormSubmission: suppressed fields", () => {
  test("a required field the contact never saw is not an error", () => {
    const def = intake()
    const values = { name: "Ann", color: "blue" }
    expect(validateFormSubmission(def, values)).toEqual([
      { key: "email", code: "required" },
    ])
    expect(
      validateFormSubmission(def, values, undefined, {
        suppressed: new Set(["email"]),
      }),
    ).toEqual([])
  })

  test("suppression never excuses a FILLED answer of the wrong type", () => {
    const def = intake()
    const values = { name: "Ann", color: "blue", email: "nope" }
    expect(
      validateFormSubmission(def, values, undefined, {
        suppressed: new Set(["email"]),
      }),
    ).toEqual([{ key: "email", code: "email" }])
  })
})

describe("planFormChat", () => {
  test("asks in document order, prefacing the display block once", () => {
    const def = intake()
    const first = planFormChat(def, {}, new Set())
    expect(first.next?.key).toBe("name")
    expect(first.preface.map((f) => f.key)).toEqual(["intro"])
    const second = planFormChat(
      def,
      { name: "Ann" },
      new Set(["intro", "name"]),
    )
    expect(second.next?.key).toBe("color")
    expect(second.preface).toEqual([])
  })

  test("a hidden field is never asked and is suppressed", () => {
    const plan = planFormChat(
      intake(),
      { name: "Ann", color: "blue" },
      new Set(["intro", "name", "color"]),
    )
    expect(plan.next?.key).toBe("email")
    expect(plan.suppressed.has("ref")).toBe(true)
  })

  test("skip_to_step is honoured: red jumps straight to notes (the divider is never sent)", () => {
    const plan = planFormChat(
      intake(),
      { name: "Ann", color: "red" },
      new Set(["intro", "name", "color"]),
    )
    expect(plan.next?.key).toBe("notes")
    expect(plan.preface).toEqual([])
  })

  test("nothing left to ask returns next null", () => {
    const plan = planFormChat(
      intake(),
      { name: "Ann", color: "red", notes: "hi" },
      new Set(["intro", "name", "color", "notes"]),
    )
    expect(plan.next).toBeNull()
  })

  test("a skipped optional field that a later rule makes required is asked again", () => {
    const def = parse({
      steps: [
        {
          id: "s1",
          fields: [
            { key: "phone", type: "phone" },
            {
              key: "contact_me",
              type: "radio",
              options: [
                { value: "yes", label: "Yes" },
                { value: "no", label: "No" },
              ],
            },
          ],
        },
      ],
      rules: [
        {
          id: "r1",
          when: {
            logic: "AND",
            rules: [{ fieldKey: "contact_me", op: "eq", value: "yes" }],
          },
          action: { type: "require", fieldKey: "phone" },
        },
      ],
    })
    const plan = planFormChat(
      def,
      { contact_me: "yes" },
      new Set(["phone", "contact_me"]),
    )
    expect(plan.next?.key).toBe("phone")
  })

  describe("progressive profiling", () => {
    const profiled = (): FormDefinition =>
      parse({
        steps: [
          {
            id: "s1",
            fields: [
              {
                key: "email",
                type: "email",
                required: true,
                profile: { showWhenKnown: false },
              },
              {
                key: "company",
                type: "text",
                profile: { showAfterSubmissions: 1 },
              },
              { key: "a", type: "text" },
              { key: "b", type: "text" },
              { key: "c", type: "text", profile: { alwaysDisplay: true } },
            ],
          },
        ],
        rules: [],
      })

    test("a known answer with showWhenKnown:false is skipped and suppressed (never required)", () => {
      const def = profiled()
      const plan = planFormChat(def, {}, new Set(), {
        known: new Set(["email"]),
        priorSubmissions: 5,
        limit: null,
      })
      expect(plan.next?.key).toBe("company")
      expect(plan.suppressed.has("email")).toBe(true)
      expect(
        validateFormSubmission(def, {}, plan.evaluation, {
          suppressed: plan.suppressed,
        }),
      ).toEqual([])
    })

    test("showAfterSubmissions hides a field until the contact has that many submissions", () => {
      const plan = planFormChat(
        profiled(),
        { email: "x@y.co" },
        new Set(["email"]),
        {
          known: new Set(),
          priorSubmissions: 0,
          limit: null,
        },
      )
      expect(plan.next?.key).toBe("a")
      expect(plan.suppressed.has("company")).toBe(true)
    })

    test("the budget counts alwaysDisplay first, then document order", () => {
      // Candidates: email, company, a, b, c(always). Limit 3: c reserves one,
      // so only email and company are asked before c.
      const ctx = { known: new Set<string>(), priorSubmissions: 1, limit: 3 }
      const def = profiled()
      const plan = planFormChat(def, {}, new Set(), ctx)
      expect(plan.next?.key).toBe("email")
      expect([...plan.suppressed].sort()).toEqual(["a", "b"])
      const after = planFormChat(
        def,
        { email: "x@y.co", company: "Acme" },
        new Set(["email", "company"]),
        ctx,
      )
      expect(after.next?.key).toBe("c")
    })

    test("a field already asked stays in budget even if the budget would now drop it", () => {
      const ctx = { known: new Set<string>(), priorSubmissions: 1, limit: 1 }
      const plan = planFormChat(profiled(), {}, new Set(["a"]), ctx)
      // `a` was asked; `c` (always) still asked; nothing else fits.
      expect(plan.next?.key).toBe("c")
      expect(plan.suppressed.has("a")).toBe(false)
    })
  })

  test("a profile on a display block is refused", () => {
    expect(() =>
      parse({
        steps: [
          {
            id: "s1",
            fields: [
              { key: "h", type: "heading", profile: { alwaysDisplay: true } },
            ],
          },
        ],
        rules: [],
      }),
    ).toThrow(NO_PROFILING_RULE)
  })

  test("an unknown profile key is refused (closed schema)", () => {
    expect(() =>
      parse({
        steps: [
          {
            id: "s1",
            fields: [
              {
                key: "t",
                type: "text",
                profile: { hideAlways: true } as never,
              },
            ],
          },
        ],
        rules: [],
      }),
    ).toThrow()
  })

  test("property: over random answer orders the planner never repeats a field and always terminates", () => {
    let seed = 20_260_928
    const rand = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed / 2_147_483_648
    }
    const def = intake()
    for (let run = 0; run < 200; run++) {
      const values: Record<string, string> = {}
      const asked = new Set<string>()
      const seen: string[] = []
      for (let turn = 0; turn < 20; turn++) {
        const plan = planFormChat(def, values, asked)
        for (const block of plan.preface) {
          asked.add(block.key)
        }
        if (!plan.next) {
          break
        }
        expect(seen).not.toContain(plan.next.key)
        seen.push(plan.next.key)
        asked.add(plan.next.key)
        values[plan.next.key] = answerFor(plan.next.key, rand)
      }
      expect(planFormChat(def, values, asked).next).toBeNull()
      expect(
        validateFormSubmission(def, values, evaluateForm(def, values)),
      ).toEqual([])
    }
  })
})

function answerFor(key: string, rand: () => number): string {
  if (key === "color") {
    return rand() < 0.5 ? "red" : "blue"
  }
  return key === "email" ? "a@b.co" : "x"
}

describe("matchFormOption", () => {
  test.each([
    ["1", "red"],
    ["2", "blue"],
    ["RED", "red"],
    ["blue sky", "blue"],
    ["  Blue  ", "blue"],
    ["3", null],
    ["0", null],
    ["", null],
    ["purple", null],
  ])("%j -> %j", (text, out) => {
    expect(matchFormOption(color, text)).toBe(out)
  })

  test("button payloads pick by position, never by value text", () => {
    expect(matchFormOption(color, "askform:1")).toBe("blue")
    expect(matchFormOption(color, "askform:9")).toBeNull()
    expect(matchFormOption(color, "askform:skip")).toBeNull()
  })

  test("numeric option values: a Telegram echo of the value matches the value, and numbering is off (blind probe)", () => {
    const numeric = {
      options: [
        { value: "3", label: "Three" },
        { value: "1", label: "One" },
        { value: "2", label: "Two" },
      ],
    }
    expect(formOptionsNumbered(numeric)).toBe(false)
    expect(matchFormOption(numeric, "1")).toBe("1")
    expect(matchFormOption(numeric, "One")).toBe("1")
    expect(formOptionsNumbered(color)).toBe(true)
  })

  test("a value shaped like a flow payload (10:30) still matches as an option", () => {
    expect(
      matchFormOption(
        { options: [{ value: "10:30", label: "Half past ten" }] },
        "10:30",
      ),
    ).toBe("10:30")
  })

  test("a field without options matches nothing", () => {
    expect(matchFormOption({ options: undefined }, "1")).toBeNull()
  })
})

describe("parseFormChatAnswer", () => {
  const def = parse({
    steps: [
      {
        id: "s1",
        fields: [
          color,
          {
            key: "tags",
            type: "checkboxGroup",
            options: [
              { value: "a", label: "Alpha" },
              { value: "b", label: "Beta" },
            ],
          },
          { key: "agree", type: "checkbox" },
          { key: "age", type: "number", min: 18 },
          { key: "email", type: "email" },
          { key: "photo", type: "image" },
          { key: "where", type: "location" },
          { key: "when", type: "date" },
        ],
      },
    ],
    rules: [],
  })
  const f = (key: string) => fieldOf(def, key)

  test.each([
    ["color", "2", { ok: true, value: "blue" }],
    ["color", "green", { ok: false, code: "option" }],
    ["tags", "beta, 1", { ok: true, value: ["a", "b"] }],
    ["tags", "alpha, zeta", { ok: false, code: "option" }],
    ["tags", " , ;", { ok: false, code: "required" }],
    ["agree", "Yes", { ok: true, value: true }],
    ["agree", "n", { ok: true, value: false }],
    ["agree", "maybe", { ok: false, code: "type" }],
    ["age", "42", { ok: true, value: 42 }],
    ["age", "17", { ok: false, code: "min" }],
    ["age", "forty", { ok: false, code: "number" }],
    ["email", " Ann@Example.COM ", { ok: true, value: "ann@example.com" }],
    ["email", "ann@", { ok: false, code: "email" }],
    [
      "photo",
      "https://cdn.example/p.jpg",
      { ok: true, value: "https://cdn.example/p.jpg" },
    ],
    ["photo", "a cat", { ok: false, code: "url" }],
    ["where", "40.7,-74.0", { ok: true, value: "40.7,-74.0" }],
    ["where", "95,10", { ok: false, code: "location" }],
    ["when", "2026-09-28", { ok: true, value: "2026-09-28" }],
    ["when", "2026-10-01T00:00:00.000Z", { ok: true, value: "2026-10-01" }],
    ["agree", "askform:yes", { ok: true, value: true }],
    ["color", "askform:0", { ok: true, value: "red" }],
    ["when", "tomorrow", { ok: false, code: "date" }],
  ] as const)("%s <- %j", (key, text, out) => {
    expect(parseFormChatAnswer(f(key), text)).toEqual(out)
  })

  test("null / non-string / empty / oversized replies are refused, never thrown", () => {
    expect(parseFormChatAnswer(f("color"), null)).toEqual({
      ok: false,
      code: "type",
    })
    expect(parseFormChatAnswer(f("color"), 3)).toEqual({
      ok: false,
      code: "type",
    })
    expect(parseFormChatAnswer(f("color"), "   ")).toEqual({
      ok: false,
      code: "required",
    })
    expect(parseFormChatAnswer(f("email"), "x".repeat(2001))).toEqual({
      ok: false,
      code: "length",
    })
  })

  test("a chat answer passes exactly the web's per-field rule", () => {
    const parsed = parseFormChatAnswer(f("age"), "20")
    expect(parsed.ok && validateFormField(f("age"), parsed.value)).toBeNull()
  })

  test("isFormChatSkip is exact and case-insensitive; the skip button counts", () => {
    expect(isFormChatSkip(" SKIP ")).toBe(true)
    expect(isFormChatSkip("askform:skip")).toBe(true)
    expect(isFormChatSkip("skip it")).toBe(false)
  })
})

// s220c A2-4: the web page's progressive profiling for a linked contact.
describe("formProfiledOutKeys", () => {
  const def = formDefinition.parse({
    steps: [
      {
        id: "s1",
        fields: [
          {
            key: "email",
            type: "email",
            label: "Email",
            required: true,
            profile: { showWhenKnown: false },
          },
          {
            key: "company",
            type: "text",
            label: "Company",
            profile: { showAfterSubmissions: 2 },
          },
          { key: "role", type: "text", label: "Role" },
          { key: "note", type: "text", label: "Note" },
          { key: "source", type: "hidden", label: "", defaultValue: "web" },
        ],
      },
    ],
    rules: [],
  })
  const profile = (
    known: string[],
    priorSubmissions: number,
    limit: number | null,
  ) => ({
    known: new Set(known),
    priorSubmissions,
    limit,
  })

  test("known answers and not-yet-due fields are hidden; hidden-type fields are not reported", () => {
    expect(formProfiledOutKeys(def, {}, profile(["email"], 0, null))).toEqual(
      new Set(["email", "company"]),
    )
    expect(formProfiledOutKeys(def, {}, profile([], 2, null))).toEqual(
      new Set(),
    )
  })

  test("the question budget hides the fields past it, in document order", () => {
    // email + company spend the budget of 2; role and note are hidden
    expect(formProfiledOutKeys(def, {}, profile([], 2, 2))).toEqual(
      new Set(["role", "note"]),
    )
  })
})
