import { describe, expect, test } from "vitest"
import { generateAuthUrl, INSTAGRAM_SCOPES } from "../src/apis/auth"

describe("generateAuthUrl (Instagram via Facebook)", () => {
  const base = { clientId: "client-id", redirectUrl: "https://example.com/cb" }

  test("requests INSTAGRAM_SCOPES by default", () => {
    const url = new URL(generateAuthUrl(base))
    expect(url.searchParams.get("scope")).toBe(INSTAGRAM_SCOPES.join(","))
    expect(url.searchParams.get("client_id")).toBe("client-id")
  })

  test("requests an explicit scope list when given", () => {
    const url = new URL(
      generateAuthUrl({ ...base, scopes: ["instagram_manage_messages"] }),
    )
    expect(url.searchParams.get("scope")).toBe("instagram_manage_messages")
  })
})
