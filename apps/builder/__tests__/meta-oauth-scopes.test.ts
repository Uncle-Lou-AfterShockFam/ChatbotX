import { describe, expect, test } from "vitest"
import { resolveMetaOAuthScopes } from "@/lib/meta-oauth-scopes"

const DEFAULTS = ["email", "pages_messaging", "page_events"] as const

describe("resolveMetaOAuthScopes", () => {
  test("unset, null or blank keeps the defaults (same reference)", () => {
    expect(resolveMetaOAuthScopes(undefined, DEFAULTS, "X")).toBe(DEFAULTS)
    expect(resolveMetaOAuthScopes(null, DEFAULTS, "X")).toBe(DEFAULTS)
    expect(resolveMetaOAuthScopes("   ", DEFAULTS, "X")).toBe(DEFAULTS)
  })

  test("parses a comma list, trims, drops empties and duplicates, keeps order", () => {
    expect(
      resolveMetaOAuthScopes(
        " pages_messaging, pages_show_list,,pages_messaging ,business_management ",
        DEFAULTS,
        "X",
      ),
    ).toEqual(["pages_messaging", "pages_show_list", "business_management"])
  })

  test("a malformed scope throws and names the variable (fail closed)", () => {
    expect(() =>
      resolveMetaOAuthScopes("pages_messaging,Bad Scope", DEFAULTS, "X"),
    ).toThrow('X: invalid scope "Bad Scope"')
    expect(() =>
      resolveMetaOAuthScopes("pages-messaging", DEFAULTS, "X"),
    ).toThrow("invalid scope")
    expect(() => resolveMetaOAuthScopes(",,,", DEFAULTS, "X")).toThrow(
      "no scopes",
    )
  })

  test("rejects a non-string value and empty defaults", () => {
    expect(() =>
      resolveMetaOAuthScopes(42 as unknown as string, DEFAULTS, "X"),
    ).toThrow(TypeError)
    expect(() => resolveMetaOAuthScopes("a", [], "X")).toThrow(TypeError)
    expect(() =>
      resolveMetaOAuthScopes("a", "nope" as unknown as string[], "X"),
    ).toThrow(TypeError)
  })
})
