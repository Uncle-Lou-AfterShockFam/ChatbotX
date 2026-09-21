import { describe, expect, test } from "vitest"
import { generateAuthUrl, MESSENGER_SCOPES } from "../src/apis/auth"

describe("generateAuthUrl", () => {
  test("asks Facebook to rerequest previously declined permissions", () => {
    const authUrl = generateAuthUrl({
      clientId: "client-id",
      redirectUrl: "https://example.com/callback",
      stateParams: { workspaceId: "workspace-id" },
    })

    expect(new URL(authUrl).searchParams.get("auth_type")).toBe("rerequest")
  })

  test("requests MESSENGER_SCOPES by default and an explicit list when given", () => {
    const base = {
      clientId: "client-id",
      redirectUrl: "https://example.com/callback",
    }
    expect(new URL(generateAuthUrl(base)).searchParams.get("scope")).toBe(
      MESSENGER_SCOPES.join(","),
    )
    const narrowed = generateAuthUrl({
      ...base,
      scopes: ["pages_messaging", "pages_show_list"],
    })
    expect(new URL(narrowed).searchParams.get("scope")).toBe(
      "pages_messaging,pages_show_list",
    )
  })
})
