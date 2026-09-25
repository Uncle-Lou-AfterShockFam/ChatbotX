import { describe, expect, test } from "vitest"
import {
  DEFAULT_FORM_SETTINGS,
  EMPTY_FORM_DEFINITION,
  FORM_EMBED_ORIGIN_REGEX,
  FORM_SLUG_REGEX,
  formSettingsSchema,
  normalizeFormDefinition,
  normalizeFormSettings,
  parseFormDefinition,
  parseFormSettings,
  slugifyFormTitle,
} from "../src/partials/form"
import { formModel, formSubmissionModel } from "../src/schema/form"

describe("form partials", () => {
  test("settings fill defaults and refuse unknown keys", () => {
    expect(formSettingsSchema.parse({})).toEqual(DEFAULT_FORM_SETTINGS)
    expect(formSettingsSchema.safeParse({ bogus: 1 }).success).toBe(false)
  })

  test.each([
    ["javascript:alert(1)", false],
    ["http://evil.example", false],
    ["https://ok.example/thanks", true],
    ["http://localhost:3000/x", true],
  ])("redirectUrl %s -> %s", (url, ok) => {
    expect(formSettingsSchema.safeParse({ redirectUrl: url }).success).toBe(ok)
  })

  test.each([
    ["https://bakery-test.makethepiebigger.com", true],
    ["https://example.com:8443", true],
    ["http://localhost:3000", true],
    ["https://example.com/", false],
    ["https://example.com/path", false],
    ["https://*.example.com", false],
    ["http://example.com", false],
    ["example.com", false],
  ])("embed origin %s -> %s", (origin, ok) => {
    expect(FORM_EMBED_ORIGIN_REGEX.test(origin)).toBe(ok)
    expect(
      formSettingsSchema.safeParse({ embedOrigins: [origin] }).success,
    ).toBe(ok)
  })

  test("caps: tags > 10, embedOrigins > 10, limit out of range", () => {
    expect(
      formSettingsSchema.safeParse({
        tags: Array.from({ length: 11 }, () => "t"),
      }).success,
    ).toBe(false)
    expect(
      formSettingsSchema.safeParse({ submitLimitPerIpPerHour: 0 }).success,
    ).toBe(false)
    expect(
      formSettingsSchema.safeParse({ submitLimitPerIpPerHour: 1001 }).success,
    ).toBe(false)
  })

  test("parseFormSettings names the offending path", () => {
    const r = parseFormSettings({ redirectUrl: "http://x.y" })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.path).toBe("redirectUrl")
    }
  })

  test("normalizeFormSettings never throws: corrupt rows fall back per key", () => {
    expect(normalizeFormSettings(null)).toEqual(DEFAULT_FORM_SETTINGS)
    expect(normalizeFormSettings("garbage")).toEqual(DEFAULT_FORM_SETTINGS)
    expect(normalizeFormSettings([1, 2])).toEqual(DEFAULT_FORM_SETTINGS)
    const mixed = normalizeFormSettings({
      honeypot: false,
      tags: "not-an-array",
      unknown: 1,
      submitLimitPerIpPerHour: 5,
    })
    expect(mixed.honeypot).toBe(false)
    expect(mixed.tags).toEqual([])
    expect(mixed.submitLimitPerIpPerHour).toBe(5)
    expect("unknown" in mixed).toBe(false)
  })

  test("parse / normalize definition", () => {
    expect(parseFormDefinition(null).success).toBe(false)
    const bad = parseFormDefinition({
      steps: [{ id: "s", fields: [{ key: "K", type: "text" }] }],
    })
    expect(bad.success).toBe(false)
    if (!bad.success) {
      expect(bad.path).toBe("steps.0.fields.0.key")
    }
    expect(normalizeFormDefinition(null)).toEqual(EMPTY_FORM_DEFINITION)
    expect(normalizeFormDefinition({ steps: "x" })).toEqual(
      EMPTY_FORM_DEFINITION,
    )
    expect(normalizeFormDefinition({ steps: [] })).toEqual(
      EMPTY_FORM_DEFINITION,
    )
  })

  test.each([
    ["Demo intake!", "demo-intake"],
    ["  Crème brûlée  ", "creme-brulee"],
    ["", "form"],
    ["---", "form"],
    ["a".repeat(80), "a".repeat(64)],
  ])("slugify %j -> %s", (title, slug) => {
    const out = slugifyFormTitle(title)
    expect(out).toBe(slug)
    expect(FORM_SLUG_REGEX.test(out)).toBe(true)
  })

  test.each([
    ["demo-intake", true],
    ["a", true],
    ["Demo", false],
    ["-demo", false],
    ["demo-", false],
    ["de mo", false],
    ["a".repeat(65), false],
  ])("slug regex %s -> %s", (slug, ok) => {
    expect(FORM_SLUG_REGEX.test(slug)).toBe(ok)
  })

  test("jsonb columns carry NO drizzle default (schema-default-parity rule)", () => {
    expect(formModel.definition.hasDefault).toBe(false)
    expect(formModel.settings.hasDefault).toBe(false)
    expect(formModel.publishedDefinition.hasDefault).toBe(false)
    expect(formSubmissionModel.values.hasDefault).toBe(false)
    expect(formSubmissionModel.visibility.hasDefault).toBe(false)
  })
})
