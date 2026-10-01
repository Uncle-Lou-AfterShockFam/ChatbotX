import { HttpResponse, http, server } from "@chatbotx.io/vitest-config/msw"
import { describe, expect, test } from "vitest"
import {
  buildGoogleSenderAuthorizeUrl,
  exchangeGoogleSenderCode,
  GOOGLE_TOKEN_URL,
  GoogleOAuthError,
  GoogleReconnectRequiredError,
  refreshGoogleAccessToken,
} from "../src/email-sender/google"

const CLIENT = { clientId: "cid.apps.googleusercontent.com", clientSecret: "s" }
const REDIRECT = "https://chat.example.org/integrations/email-sender/callback"

const idToken = (claims: Record<string, unknown>) =>
  [
    Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url"),
    Buffer.from(
      JSON.stringify({
        iss: "https://accounts.google.com",
        aud: CLIENT.clientId,
        email: "Sender@Example.org",
        email_verified: true,
        ...claims,
      }),
    ).toString("base64url"),
    "sig",
  ].join(".")

const grantBody = (overrides: Record<string, unknown> = {}) => ({
  access_token: "ya29.access",
  expires_in: 3599,
  refresh_token: "1//refresh",
  scope:
    "https://mail.google.com/ openid https://www.googleapis.com/auth/userinfo.email",
  token_type: "Bearer",
  id_token: idToken({}),
  ...overrides,
})

const answer = (status: number, body: unknown) =>
  server.use(
    http.post(GOOGLE_TOKEN_URL, () => HttpResponse.json(body, { status })),
  )

const exchange = () =>
  exchangeGoogleSenderCode({ client: CLIENT, code: "c", redirectUri: REDIRECT })

describe("google mailbox-sender OAuth client (s230b)", () => {
  test("authorize URL asks offline + consent for the mail, openid and email scopes", () => {
    const url = new URL(
      buildGoogleSenderAuthorizeUrl({
        clientId: CLIENT.clientId,
        redirectUri: REDIRECT,
        state: "st",
        loginHint: "sender@example.org",
      }),
    )
    expect(url.origin + url.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    )
    expect(url.searchParams.get("scope")).toBe(
      "https://mail.google.com/ openid https://www.googleapis.com/auth/userinfo.email",
    )
    expect(url.searchParams.get("access_type")).toBe("offline")
    expect(url.searchParams.get("prompt")).toBe("consent")
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT)
    expect(url.searchParams.get("state")).toBe("st")
    expect(url.searchParams.get("login_hint")).toBe("sender@example.org")
  })

  test("exchange posts the code with the client and returns the verified, lower-cased address", async () => {
    let form: URLSearchParams | null = null
    server.use(
      http.post(GOOGLE_TOKEN_URL, async ({ request }) => {
        form = new URLSearchParams(await request.text())
        return HttpResponse.json(grantBody())
      }),
    )
    const before = Date.now()
    const grant = await exchange()
    expect(form?.get("grant_type")).toBe("authorization_code")
    expect(form?.get("code")).toBe("c")
    expect(form?.get("redirect_uri")).toBe(REDIRECT)
    expect(form?.get("client_secret")).toBe("s")
    expect(grant).toMatchObject({
      accessToken: "ya29.access",
      refreshToken: "1//refresh",
      email: "sender@example.org",
    })
    expect(grant.expiresAt).toBeGreaterThanOrEqual(before + 3599 * 1000)
  })

  test.each([
    ["no refresh token", { refresh_token: undefined }, "no-refresh-token"],
    [
      "the Gmail scope not granted",
      { scope: "openid https://www.googleapis.com/auth/userinfo.email" },
      "gmail-scope-not-granted",
    ],
    [
      "an id_token for another client",
      { id_token: idToken({ aud: "other" }) },
      "no-verified-email",
    ],
    [
      "an unverified address",
      { id_token: idToken({ email_verified: false }) },
      "no-verified-email",
    ],
    [
      "a foreign issuer",
      { id_token: idToken({ iss: "https://evil.example" }) },
      "no-verified-email",
    ],
    ["no id_token", { id_token: undefined }, "no-verified-email"],
    ["a garbage id_token", { id_token: "x.%%%.y" }, "no-verified-email"],
  ])("exchange refuses %s", async (_label, overrides, message) => {
    answer(200, grantBody(overrides))
    const error = await exchange().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(GoogleOAuthError)
    expect((error as GoogleOAuthError).message).toBe(message)
    expect((error as GoogleOAuthError).retryable).toBe(false)
  })

  test.each([
    ["no access token", { access_token: undefined }],
    [
      "an access token over the line's 2048 cap",
      { access_token: "a".repeat(2049) },
    ],
    ["an access token with a space", { access_token: "ya29 x" }],
  ])("exchange refuses %s", async (_label, overrides) => {
    answer(200, grantBody(overrides))
    await expect(exchange()).rejects.toThrow("no usable access token")
  })

  test("invalid_grant is a reconnect, never a retry", async () => {
    answer(400, {
      error: "invalid_grant",
      error_description: "Token has been expired or revoked.",
    })
    await expect(
      refreshGoogleAccessToken({ client: CLIENT, refreshToken: "r" }),
    ).rejects.toBeInstanceOf(GoogleReconnectRequiredError)
  })

  test("a 5xx or 429 is retryable, a 401 is not; the description never lands in the message", async () => {
    answer(503, { error: "backend_error", error_description: "secret detail" })
    const e503 = (await refreshGoogleAccessToken({
      client: CLIENT,
      refreshToken: "r",
    }).catch((e: unknown) => e)) as GoogleOAuthError
    expect(e503.retryable).toBe(true)
    expect(e503.message).not.toContain("secret detail")
    answer(429, {})
    const e429 = (await refreshGoogleAccessToken({
      client: CLIENT,
      refreshToken: "r",
    }).catch((e: unknown) => e)) as GoogleOAuthError
    expect(e429.retryable).toBe(true)
    answer(401, { error: "invalid_client" })
    const e401 = (await refreshGoogleAccessToken({
      client: CLIENT,
      refreshToken: "r",
    }).catch((e: unknown) => e)) as GoogleOAuthError
    expect(e401).toBeInstanceOf(GoogleOAuthError)
    expect(e401.retryable).toBe(false)
    expect(e401.message).toContain("invalid_client")
  })

  test("a network failure is retryable", async () => {
    server.use(http.post(GOOGLE_TOKEN_URL, () => HttpResponse.error()))
    const error = (await refreshGoogleAccessToken({
      client: CLIENT,
      refreshToken: "r",
    }).catch((e: unknown) => e)) as GoogleOAuthError
    expect(error).toBeInstanceOf(GoogleOAuthError)
    expect(error.retryable).toBe(true)
  })

  test("refresh keeps the stored refresh token unless Google rotates it", async () => {
    let form: URLSearchParams | null = null
    server.use(
      http.post(GOOGLE_TOKEN_URL, async ({ request }) => {
        form = new URLSearchParams(await request.text())
        return HttpResponse.json({ access_token: "ya29.new", expires_in: 3600 })
      }),
    )
    const fresh = await refreshGoogleAccessToken({
      client: CLIENT,
      refreshToken: "1//r",
    })
    expect(form?.get("grant_type")).toBe("refresh_token")
    expect(form?.get("refresh_token")).toBe("1//r")
    expect(fresh).toMatchObject({ accessToken: "ya29.new", refreshToken: null })
    answer(200, { access_token: "ya29.n2", refresh_token: "1//rotated" })
    await expect(
      refreshGoogleAccessToken({ client: CLIENT, refreshToken: "1//r" }),
    ).resolves.toMatchObject({ refreshToken: "1//rotated" })
  })

  // The 64 KB cap itself is readCapped's (sdk outbound-fetch tests); MSW's
  // stream never settles a cancel, so the oversized case is not replayed here.
  test("a non-JSON answer is a retryable failure, not a crash", async () => {
    server.use(
      http.post(
        GOOGLE_TOKEN_URL,
        () => new HttpResponse("<html>not json</html>", { status: 200 }),
      ),
    )
    await expect(
      refreshGoogleAccessToken({ client: CLIENT, refreshToken: "r" }),
    ).rejects.toThrow("no usable access token")
  })
})
