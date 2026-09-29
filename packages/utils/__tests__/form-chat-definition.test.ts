import { describe, expect, test } from "vitest"
import {
  FORM_CHAT_ONLY_FIELD_TYPES,
  type FormDefinitionInput,
  formChatOnlyFields,
  formDefinition,
  MAX_FORM_OPTION_POINTS,
} from "../src/form"

// s219 A2-1: one definition runs on the web AND in chat. Chat-only field
// types, per-field chat props, option points and the fullName system key
// (the scoring and answer validation live in form-evaluate.test.ts).

const one = (field: Record<string, unknown>): FormDefinitionInput => ({
  steps: [{ id: "s1", fields: [field as never] }],
  rules: [],
})

const issues = (input: FormDefinitionInput) => {
  const parsed = formDefinition.safeParse(input)
  return parsed.success ? [] : parsed.error.issues.map((i) => i.message)
}

describe("chat-only field types", () => {
  test("location parses and is listed as chat-only", () => {
    const parsed = formDefinition.parse(one({ key: "q", type: "location" }))
    expect(FORM_CHAT_ONLY_FIELD_TYPES.has("location")).toBe(true)
    expect(formChatOnlyFields(parsed).map((f) => f.key)).toEqual(["q"])
  })

  // s225a A2-4 PR 5: photo / file fields run on the web as private uploads.
  test.each(["image", "file"])("%s parses and is NOT chat-only", (type) => {
    const parsed = formDefinition.parse(one({ key: "q", type }))
    expect(FORM_CHAT_ONLY_FIELD_TYPES.has(type as never)).toBe(false)
    expect(formChatOnlyFields(parsed)).toEqual([])
  })

  test("maxSizeMb: whole MB 1..10, and only on a photo / file field", () => {
    expect(issues(one({ key: "q", type: "file", maxSizeMb: 1 }))).toEqual([])
    expect(issues(one({ key: "q", type: "image", maxSizeMb: 10 }))).toEqual([])
    for (const bad of [0, 11, 2.5, -1]) {
      expect(
        issues(one({ key: "q", type: "file", maxSizeMb: bad })),
      ).not.toEqual([])
    }
    expect(issues(one({ key: "q", type: "text", maxSizeMb: 2 }))).toEqual([
      "Only a photo or file field has a size limit.",
    ])
    expect(
      issues(one({ key: "q", type: "location", maxSizeMb: 2 })),
    ).not.toEqual([])
  })

  test.each([
    ["pattern", { pattern: "a" }],
    ["min", { min: 1 }],
    ["max", { max: 2 }],
    ["defaultValue", { defaultValue: "x" }],
  ])("an image field cannot carry %s", (_prop, extra) => {
    expect(issues(one({ key: "q", type: "image", ...extra }))).not.toEqual([])
  })

  test("a chat-only answer maps to a custom field, never a system field", () => {
    expect(
      issues(
        one({
          key: "q",
          type: "file",
          mapTo: { kind: "custom", customFieldId: "77" },
        }),
      ),
    ).toEqual([])
    expect(
      issues(
        one({
          key: "q",
          type: "location",
          mapTo: { kind: "system", key: "email" },
        }),
      ),
    ).not.toEqual([])
  })

  test("an ordinary web form has no chat-only fields", () => {
    const parsed = formDefinition.parse(one({ key: "q", type: "text" }))
    expect(formChatOnlyFields(parsed)).toEqual([])
  })
})

describe("chat props", () => {
  test("prompt, retryMessage and an https mediaUrl parse", () => {
    expect(
      issues(
        one({
          key: "q",
          type: "text",
          chat: {
            prompt: "What is your name?",
            retryMessage: "Just your name, please.",
            mediaUrl: "https://cdn.example.com/a.png",
          },
        }),
      ),
    ).toEqual([])
  })

  test.each([
    ["an http mediaUrl", { mediaUrl: "http://cdn.example.com/a.png" }],
    ["a non-URL mediaUrl", { mediaUrl: "not a url" }],
    ["a javascript: mediaUrl", { mediaUrl: "javascript:alert(1)" }],
    ["an empty prompt", { prompt: "" }],
    ["an unknown key (closed schema)", { voice: "x" }],
    ["an over-long retry", { retryMessage: "x".repeat(501) }],
  ])("refuses %s", (_label, chat) => {
    expect(issues(one({ key: "q", type: "text", chat }))).not.toEqual([])
  })

  test("a display block asks nothing, so it has no retry message", () => {
    expect(
      issues(
        one({ key: "h", type: "heading", chat: { retryMessage: "again" } }),
      ),
    ).not.toEqual([])
    expect(
      issues(one({ key: "h", type: "heading", chat: { prompt: "Hello!" } })),
    ).toEqual([])
  })

  test("null chat props are refused, not treated as absent", () => {
    expect(issues(one({ key: "q", type: "text", chat: null }))).not.toEqual([])
  })
})

describe("fullName", () => {
  const nameField = (key: string, system: string) => ({
    key,
    type: "text",
    mapTo: { kind: "system", key: system },
  })

  test("parses on its own", () => {
    expect(issues(one(nameField("name", "fullName")))).toEqual([])
  })

  test.each([
    "firstName",
    "lastName",
  ])("cannot be mapped beside %s", (other) => {
    expect(
      issues({
        steps: [
          {
            id: "s1",
            fields: [
              nameField("name", "fullName") as never,
              nameField("part", other) as never,
            ],
          },
        ],
        rules: [],
      }),
    ).toContain("Full name cannot be mapped together with first or last name.")
  })
})

describe("option points", () => {
  test.each([
    MAX_FORM_OPTION_POINTS + 1,
    -MAX_FORM_OPTION_POINTS - 1,
    1.5,
    Number.NaN,
  ])("refuses points %s", (points) => {
    expect(
      issues(
        one({
          key: "q",
          type: "radio",
          options: [{ value: "x", label: "X", points }],
        }),
      ),
    ).not.toEqual([])
  })
})
