import { afterEach, describe, expect, test } from "vitest"
import {
  INSTAGRAM_FACEBOOK_OAUTH_SCOPES_ENV,
  instagramFacebookOAuthScopes,
  MESSENGER_OAUTH_SCOPES_ENV,
  messengerOAuthScopes,
  resolveMetaOAuthScopes,
} from "@/lib/meta-oauth-scopes"

const DEFAULTS = ["email", "pages_messaging", "page_events"] as const

afterEach(() => {
  delete process.env[MESSENGER_OAUTH_SCOPES_ENV]
  delete process.env[INSTAGRAM_FACEBOOK_OAUTH_SCOPES_ENV]
})

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

  test("the env readers pick up their own variable only", () => {
    process.env[MESSENGER_OAUTH_SCOPES_ENV] = "pages_messaging,pages_show_list"
    expect(messengerOAuthScopes(DEFAULTS)).toEqual([
      "pages_messaging",
      "pages_show_list",
    ])
    expect(instagramFacebookOAuthScopes(DEFAULTS)).toBe(DEFAULTS)

    process.env[INSTAGRAM_FACEBOOK_OAUTH_SCOPES_ENV] =
      "instagram_manage_messages"
    expect(instagramFacebookOAuthScopes(DEFAULTS)).toEqual([
      "instagram_manage_messages",
    ])
  })
})
