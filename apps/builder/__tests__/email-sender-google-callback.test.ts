// @vitest-environment node

import {
  mintEmailSenderOAuthNonce,
  signEmailSenderOAuthState,
} from "@chatbotx.io/encryption/email-sender-oauth-state"
import type { NextRequest } from "next/server"
import { beforeEach, describe, expect, test, vi } from "vitest"

/**
 * The Google mailbox-sender OAuth callback (s230b): nothing is exchanged
 * unless the signed state verifies for THIS user with THIS browser's nonce
 * cookie and the user is still a super admin; the nonce is spent on first
 * use; every outcome is a closed code, never an error's text.
 */
const {
  mockGetCurrentUser,
  mockTarget,
  mockHasPermission,
  mockConnectGoogle,
  mockCookieGet,
  mockCookieSet,
  mockRedirect,
  mockNotFound,
} = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
  mockTarget: vi.fn(),
  mockHasPermission: vi.fn(),
  mockConnectGoogle: vi.fn(),
  mockCookieGet: vi.fn(),
  mockCookieSet: vi.fn(),
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`)
  }),
  mockNotFound: vi.fn(() => {
    throw new Error("not-found")
  }),
}))

vi.mock("@chatbotx.io/business", () => ({
  platformCredentialService: {
    resolveForOwner: vi.fn(async () => ({
      userId: null,
      config: { clientId: "cid", clientSecret: "s" },
    })),
  },
}))
vi.mock("@chatbotx.io/business/audit", () => ({
  withAuditContext: async (_ctx: unknown, fn: () => Promise<unknown>) =>
    await fn(),
}))
vi.mock("@chatbotx.io/business/email-sender", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@chatbotx.io/business/email-sender")>()
  return {
    ...actual,
    emailSenderService: { connectGoogle: mockConnectGoogle },
  }
})
vi.mock("@chatbotx.io/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@chatbotx.io/utils")>()
  return {
    ...actual,
    getPublicUrlFromRequest: (request: { url: string }) => request.url,
  }
})
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: mockCookieGet, set: mockCookieSet })),
}))
vi.mock("next/navigation", () => ({
  redirect: mockRedirect,
  notFound: mockNotFound,
}))
vi.mock("@/lib/auth/utils", () => ({
  getCurrentUser: mockGetCurrentUser,
  getCurrentUserAndTargetWorkspace: mockTarget,
}))
vi.mock("@/lib/auth/permission-routes", () => ({
  hasWorkspacePermission: mockHasPermission,
}))
vi.mock("@/lib/platform-credential-owner", () => ({
  resolvePlatformOwnerId: vi.fn(async () => "owner-1"),
}))
vi.mock("@/lib/provider-origin", () => ({
  buildProviderCallbackUrl: vi.fn(
    async (_c: unknown, path: string) => `https://chat.example.org${path}`,
  ),
}))
vi.mock("@/lib/log", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))
vi.mock("@/lib/rate-limit/guest-rate-limit", () => ({
  getGuestClientIp: () => "127.0.0.1",
}))

const { GET } = await import(
  "../src/app/integrations/email-sender/callback/route"
)
const { GoogleOAuthError } = await import("@chatbotx.io/business/email-sender")
const { ChatbotXException, emailSenderGoogleMismatchException } = await import(
  "@chatbotx.io/business/errors"
)

const USER = "11701868563300001"
const WORKSPACE = "11701868563365888"
const LINE = "11701908099366912"
const BACK = `/space/${WORKSPACE}/settings/email-senders`

async function state(extra: Record<string, string> = {}) {
  const nonce = mintEmailSenderOAuthNonce()
  const signed = await signEmailSenderOAuthState({
    workspaceId: WORKSPACE,
    userId: USER,
    lineInboxId: LINE,
    ...(extra.senderId
      ? {}
      : { fromName: "Lou P", firstName: "Lou", lastName: "P" }),
    ...extra,
    nonce,
  })
  return { nonce, signed }
}

async function call(query: Record<string, string>): Promise<string> {
  const url = new URL(
    "https://chat.example.org/integrations/email-sender/callback",
  )
  for (const [k, v] of Object.entries(query)) {
    url.searchParams.set(k, v)
  }
  try {
    await GET({
      url: url.toString(),
      headers: new Headers(),
    } as unknown as NextRequest)
  } catch (error) {
    return (error as Error).message
  }
  return "returned"
}

beforeEach(() => {
  mockGetCurrentUser.mockResolvedValue({ id: USER })
  mockTarget.mockResolvedValue({ targetWorkspaceMember: { permissions: [] } })
  mockHasPermission.mockReturnValue(true)
  mockConnectGoogle.mockResolvedValue({ id: "1" })
})

describe("email sender Google callback (s230b)", () => {
  test("a valid state connects a new sender with the state's identity and the exact redirect URI", async () => {
    const { nonce, signed } = await state()
    mockCookieGet.mockReturnValue({ value: nonce })
    expect(await call({ state: signed, code: "c0de" })).toBe(
      `redirect:${BACK}?emailSenderConnect=connected`,
    )
    expect(mockConnectGoogle).toHaveBeenCalledWith(
      {
        workspaceId: WORKSPACE,
        lineInboxId: LINE,
        ownerId: "owner-1",
        code: "c0de",
        redirectUri:
          "https://chat.example.org/integrations/email-sender/callback",
        fromName: "Lou P",
        firstName: "Lou",
        lastName: "P",
      },
      USER,
    )
    // The nonce cookie is spent on first use.
    expect(mockCookieSet).toHaveBeenCalledWith(
      "email_sender_oauth_nonce",
      "",
      expect.objectContaining({
        maxAge: 0,
        path: "/integrations/email-sender",
      }),
    )
  })

  test("a reconnect state passes only the sender id", async () => {
    const { nonce, signed } = await state({ senderId: "42" })
    mockCookieGet.mockReturnValue({ value: nonce })
    await call({ state: signed, code: "c" })
    const [input] = mockConnectGoogle.mock.calls[0] ?? []
    expect(input).toMatchObject({ senderId: "42" })
    expect(input).not.toHaveProperty("fromName")
  })

  test.each([
    [
      "no signed-in user",
      async () => mockGetCurrentUser.mockResolvedValue(null),
    ],
    [
      "another browser (no nonce cookie)",
      async () => mockCookieGet.mockReturnValue(undefined),
    ],
    [
      "another browser's nonce",
      async () =>
        mockCookieGet.mockReturnValue({ value: mintEmailSenderOAuthNonce() }),
    ],
    [
      "another user",
      async () => mockGetCurrentUser.mockResolvedValue({ id: "9" }),
    ],
    [
      "a user who is no longer super admin",
      async () => mockHasPermission.mockReturnValue(false),
    ],
    [
      "a user who left the workspace",
      async () => mockTarget.mockResolvedValue(null),
    ],
  ])("%s: 404 and nothing exchanged", async (_label, arrange) => {
    const { nonce, signed } = await state()
    mockCookieGet.mockReturnValue({ value: nonce })
    await arrange()
    expect(await call({ state: signed, code: "c" })).toBe("not-found")
    expect(mockConnectGoogle).not.toHaveBeenCalled()
  })

  test.each([
    [
      "a forged bare-base64 state",
      btoa(JSON.stringify({ workspaceId: WORKSPACE })),
    ],
    ["no state", ""],
  ])("%s: 404", async (_label, forged) => {
    mockCookieGet.mockReturnValue({ value: mintEmailSenderOAuthNonce() })
    expect(await call({ state: forged, code: "c" })).toBe("not-found")
    expect(mockConnectGoogle).not.toHaveBeenCalled()
  })

  test.each([
    ["admin_policy_enforced", "untrusted"],
    ["org_internal", "untrusted"],
    ["access_denied", "cancelled"],
    ["server_error", "failed"],
  ])("Google error %s -> %s, nothing exchanged", async (error, outcome) => {
    const { nonce, signed } = await state()
    mockCookieGet.mockReturnValue({ value: nonce })
    expect(await call({ state: signed, error })).toBe(
      `redirect:${BACK}?emailSenderConnect=${outcome}`,
    )
    expect(mockConnectGoogle).not.toHaveBeenCalled()
  })

  test.each([
    [
      new GoogleOAuthError("gmail-scope-not-granted", {
        status: 200,
        retryable: false,
      }),
      "scope",
    ],
    [
      new GoogleOAuthError("no-refresh-token", {
        status: 200,
        retryable: false,
      }),
      "failed",
    ],
    [emailSenderGoogleMismatchException("a@example.org"), "mismatch"],
    [
      Object.assign(new ChatbotXException("dup", "validation", 422), {
        field: "address",
      }),
      "duplicate",
    ],
    [new Error("SELECT * FROM secret"), "failed"],
  ])("a connect failure is a closed code (%s)", async (error, outcome) => {
    const { nonce, signed } = await state()
    mockCookieGet.mockReturnValue({ value: nonce })
    mockConnectGoogle.mockRejectedValue(error)
    const result = await call({ state: signed, code: "c" })
    expect(result).toBe(`redirect:${BACK}?emailSenderConnect=${outcome}`)
  })
})
