import { describe, expect, test } from "vitest"
import {
  DEFAULT_FORM_SETTINGS,
  EMPTY_FORM_DEFINITION,
  FORM_EMBED_ORIGIN_REGEX,
  FORM_SLUG_REGEX,
  formSettingsSchema,
  formWindowState,
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

// s220c A2-4: availability window, submission limit, blocked email domains.
describe("form availability settings", () => {
  test("defaults: open both sides, no limit, no blocked domains, default messages", () => {
    expect(DEFAULT_FORM_SETTINGS).toMatchObject({
      publishUp: null,
      publishDown: null,
      submissionLimit: null,
      blockedEmailDomains: [],
      pendingMessage: "This form is not open yet.",
      closedMessage: "This form is closed.",
    })
  })

  test("a window that closes before (or when) it opens is refused at write, with its path", () => {
    const r = parseFormSettings({
      publishUp: "2026-10-02T09:00:00Z",
      publishDown: "2026-10-01T09:00:00Z",
    })
    expect(r).toMatchObject({ success: false, path: "publishDown" })
    const same = parseFormSettings({
      publishUp: "2026-10-02T09:00:00Z",
      publishDown: "2026-10-02T09:00:00Z",
    })
    expect(same.success).toBe(false)
    expect(
      parseFormSettings({
        publishUp: "2026-10-01T09:00:00-04:00",
        publishDown: "2026-10-01T14:00:00Z",
      }).success,
    ).toBe(true)
  })

  test("a bound must be an instant WITH its offset (a bare local time is ambiguous)", () => {
    expect(parseFormSettings({ publishUp: "2026-10-01T09:00" }).success).toBe(
      false,
    )
    expect(parseFormSettings({ publishUp: "tomorrow" }).success).toBe(false)
  })

  test("submission limit: 1..100000 or null", () => {
    expect(parseFormSettings({ submissionLimit: 0 }).success).toBe(false)
    expect(parseFormSettings({ submissionLimit: 100_001 }).success).toBe(false)
    expect(parseFormSettings({ submissionLimit: 2.5 }).success).toBe(false)
    expect(parseFormSettings({ submissionLimit: 100_000 }).success).toBe(true)
  })

  test("blocked domains: lower-cased, bare domains only, no duplicates, at most 100", () => {
    const ok = parseFormSettings({
      blockedEmailDomains: [" Example.COM ", "mail.test.org"],
    })
    expect(ok.success && ok.data.blockedEmailDomains).toEqual([
      "example.com",
      "mail.test.org",
    ])
    for (const bad of [
      "@example.com",
      "https://example.com",
      "*.example.com",
      "example",
      "exa mple.com",
    ]) {
      expect(parseFormSettings({ blockedEmailDomains: [bad] }).success).toBe(
        false,
      )
    }
    expect(
      parseFormSettings({ blockedEmailDomains: ["a.com", "A.com"] }).success,
    ).toBe(false)
    const many = Array.from({ length: 101 }, (_, i) => `d${i}.com`)
    expect(parseFormSettings({ blockedEmailDomains: many }).success).toBe(false)
  })

  test("normalize: a corrupt limit falls back to its default, the rest survives", () => {
    const n = normalizeFormSettings({
      submissionLimit: "lots",
      closedMessage: "Gone.",
    })
    expect(n).toMatchObject({ submissionLimit: null, closedMessage: "Gone." })
  })

  test("normalize: a corrupt stored window bound keeps the form CLOSED, never open (blind probe s220c)", () => {
    const now = new Date("2026-10-01T12:00:00Z")
    for (const raw of [
      { publishUp: 5 },
      { publishDown: "garbage" },
      { publishUp: { a: 1 } },
    ]) {
      expect(formWindowState(normalizeFormSettings(raw), now)).toBe("closed")
    }
    // absent / null bounds stay open
    expect(
      formWindowState(normalizeFormSettings({ publishUp: null }), now),
    ).toBe("open")
    expect(formWindowState(normalizeFormSettings({}), now)).toBe("open")
  })

  test("formWindowState: publishUp inclusive, publishDown exclusive, null = open that side", () => {
    const w = {
      publishUp: "2026-10-01T09:00:00Z",
      publishDown: "2026-10-02T09:00:00Z",
    }
    expect(formWindowState(w, new Date("2026-10-01T08:59:59.999Z"))).toBe(
      "pending",
    )
    expect(formWindowState(w, new Date("2026-10-01T09:00:00Z"))).toBe("open")
    expect(formWindowState(w, new Date("2026-10-02T08:59:59.999Z"))).toBe(
      "open",
    )
    expect(formWindowState(w, new Date("2026-10-02T09:00:00Z"))).toBe("closed")
    expect(
      formWindowState({ publishUp: null, publishDown: null }, new Date(0)),
    ).toBe("open")
    expect(
      formWindowState(
        { publishUp: null, publishDown: w.publishDown },
        new Date("2020-01-01T00:00:00Z"),
      ),
    ).toBe("open")
  })

  test("formWindowState fails CLOSED on an unparseable bound (a hand-edited row), never open", () => {
    const now = new Date("2026-10-01T12:00:00Z")
    expect(
      formWindowState({ publishUp: "garbage", publishDown: null }, now),
    ).toBe("closed")
    expect(
      formWindowState({ publishUp: null, publishDown: "garbage" }, now),
    ).toBe("closed")
  })
})

describe("personal form link key (s220c A2-4)", () => {
  test("`k` can never be a prefill key (it carries the link's token)", () => {
    expect(parseFormSettings({ prefillKeys: ["k"] }).success).toBe(false)
    expect(
      parseFormSettings({ prefillKeys: ["first_name", "k"] }).success,
    ).toBe(false)
    expect(
      parseFormSettings({ prefillKeys: ["kind", "first_name"] }).success,
    ).toBe(true)
  })

  test.each([
    [undefined, 30],
    [5, 5],
    [1440, 1440],
  ])("abandonAfterMinutes %s -> %s (s224a A2-4)", (v, want) => {
    expect(
      formSettingsSchema.parse(
        v === undefined ? {} : { abandonAfterMinutes: v },
      ).abandonAfterMinutes,
    ).toBe(want)
  })

  test.each([
    4,
    1441,
    7.5,
    "30",
    null,
    -1,
  ])("abandonAfterMinutes %s is refused on write, defaulted on read", (v) => {
    expect(parseFormSettings({ abandonAfterMinutes: v }).success).toBe(false)
    expect(
      normalizeFormSettings({ abandonAfterMinutes: v }).abandonAfterMinutes,
    ).toBe(30)
  })
})
