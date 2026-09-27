// @vitest-environment node
import ky from "ky"
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest"
import {
  refreshWebchatAccessToken,
  WEBCHAT_TOKEN_REFRESH_GRACE_SECONDS,
} from "@/features/integration-webchat/lib/refresh-webchat-token"
import {
  createWebchatAccessToken,
  readWebchatAccessToken,
  TOKEN_TTL_SECONDS,
  verifyWebchatAccessToken,
} from "@/features/integration-webchat/lib/webchat-access-token"
import {
  isWebchatTokenDue,
  WEBCHAT_TOKEN_MIN_REFRESH_INTERVAL_MS,
  WEBCHAT_TOKEN_REFRESH_LEAD_MS,
  webchatTokenRefreshDelayMs,
} from "@/features/integration-webchat/lib/webchat-token-expiry"
import { createGuestSessionStore } from "@/features/integration-webchat/providers/store/guest-sesssion-store"

vi.mock("@/features/messages/actions/create-webchat-message.action", () => ({
  createWebchatMessageAction: {},
}))

// s210 owner decision: a silent guest-token refresh that re-runs the embed
// gate on the host the token is bound to.
const HUB = "app.chatbotx.io"
const WS = "11701868563365888"
const CHAT = "42"
const T0 = new Date("2026-09-27T12:00:00Z")

beforeAll(() => {
  process.env.BETTER_AUTH_SECRET = "test-better-auth-secret"
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const mint = async (origin: string | null, at = T0) => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(at)
  const token = await createWebchatAccessToken({
    origin,
    webchatId: CHAT,
    workspaceId: WS,
  })
  vi.useRealTimers()
  return token
}

const deps = (
  domains: string[] | null = ["shop.example"],
  active = true,
  nowSeconds = Math.floor(T0.getTime() / 1000),
) => ({
  loadAuthorizedDomains: vi.fn(async () => domains),
  isWorkspaceActive: vi.fn(async () => active),
  nowSeconds: () => nowSeconds,
})

const input = (token: string | null, parentOrigin: string | null) => ({
  token,
  workspaceId: WS,
  webchatId: CHAT,
  parentOrigin,
  appHost: HUB,
})

describe("refreshWebchatAccessToken", () => {
  test("an allowlisted embed gets a fresh token bound to the same host", async () => {
    const old = await mint("https://www.shop.example/page")
    const fresh = await refreshWebchatAccessToken(
      input(old, "www.shop.example"),
      deps(),
    )
    expect(fresh).toEqual(expect.any(String))
    const payload = await readWebchatAccessToken(fresh)
    expect(payload?.originHost).toBe("www.shop.example")
    expect(
      (
        await verifyWebchatAccessToken({
          token: fresh,
          origin: "www.shop.example",
          webchatId: CHAT,
          workspaceId: WS,
        })
      ).authorized,
    ).toBe(true)
  })

  test("an expired token inside the grace window refreshes; past it, it does not", async () => {
    const old = await mint("shop.example")
    const exp = Math.floor(T0.getTime() / 1000) + TOKEN_TTL_SECONDS
    expect(
      await refreshWebchatAccessToken(
        input(old, "shop.example"),
        deps(["shop.example"], true, exp + 3600),
      ),
    ).toEqual(expect.any(String))
    expect(
      await refreshWebchatAccessToken(
        input(old, "shop.example"),
        deps(
          ["shop.example"],
          true,
          exp + WEBCHAT_TOKEN_REFRESH_GRACE_SECONDS + 1,
        ),
      ),
    ).toBeNull()
  })

  test.each([
    ["no parentOrigin (a direct open)", null, null, ["shop.example"]],
    ["the hub's own preview", HUB, HUB, ["shop.example"]],
    ["a direct open with an empty allowlist", null, null, []],
  ])("first party: %s refreshes", async (_, mintedFor, presented, list) => {
    const old = await mint(mintedFor)
    expect(
      await refreshWebchatAccessToken(input(old, presented), deps(list)),
    ).toEqual(expect.any(String))
  })

  test("the gate runs again: a host removed from the allowlist is refused", async () => {
    const old = await mint("shop.example")
    expect(
      await refreshWebchatAccessToken(
        input(old, "shop.example"),
        deps(["other.example"]),
      ),
    ).toBeNull()
    expect(
      await refreshWebchatAccessToken(input(old, "shop.example"), deps([])),
    ).toBeNull()
  })

  test("a deleted webchat or a workspace being deleted is refused", async () => {
    const old = await mint("shop.example")
    expect(
      await refreshWebchatAccessToken(input(old, "shop.example"), deps(null)),
    ).toBeNull()
    expect(
      await refreshWebchatAccessToken(
        input(old, "shop.example"),
        deps(["shop.example"], false),
      ),
    ).toBeNull()
  })

  test("a token presented from another host, or for another webchat, is refused before any lookup", async () => {
    const old = await mint("shop.example")
    const d = deps()
    expect(
      await refreshWebchatAccessToken(input(old, "evil.example"), d),
    ).toBeNull()
    expect(await refreshWebchatAccessToken(input(old, null), d)).toBeNull()
    expect(
      await refreshWebchatAccessToken(
        { ...input(old, "shop.example"), webchatId: "43" },
        d,
      ),
    ).toBeNull()
    expect(d.loadAuthorizedDomains).not.toHaveBeenCalled()
  })

  test("forged, malformed and oversized tokens are refused", async () => {
    const old = await mint("shop.example")
    const [payload, signature] = old.split(".")
    const forgedPayload = Buffer.from(
      JSON.stringify({
        exp: 9_999_999_999,
        originHost: "evil.example",
        webchatId: CHAT,
        workspaceId: WS,
      }),
    ).toString("base64url")
    for (const token of [
      null,
      "",
      "abc",
      `${forgedPayload}.${signature}`,
      `${payload}.${"0".repeat(64)}`,
      `${old}.extra`,
      `${payload}.${signature}`.repeat(20),
    ]) {
      expect(
        await refreshWebchatAccessToken(input(token, "shop.example"), deps()),
      ).toBeNull()
    }
  })
})

describe("readWebchatAccessToken", () => {
  test("rejects a correctly signed payload with wrong field types", async () => {
    // Sign a bad payload the same way the module does.
    const { hmacSha256Hex } = await import("@chatbotx.io/utils/crypto")
    const bad = Buffer.from(
      JSON.stringify({ exp: "never", originHost: 7, webchatId: 1 }),
    ).toString("base64url")
    const signature = await hmacSha256Hex("test-better-auth-secret", bad)
    expect(await readWebchatAccessToken(`${bad}.${signature}`)).toBeNull()
  })
})

describe("webchat token refresh timing (client)", () => {
  const TTL_MS = TOKEN_TTL_SECONDS * 1000
  test("due the lead time before the TTL runs out, counted from arrival", () => {
    expect(webchatTokenRefreshDelayMs(1000, 1000)).toBe(
      TTL_MS - WEBCHAT_TOKEN_REFRESH_LEAD_MS,
    )
    expect(
      isWebchatTokenDue(0, TTL_MS - WEBCHAT_TOKEN_REFRESH_LEAD_MS - 1),
    ).toBe(false)
    expect(isWebchatTokenDue(0, TTL_MS - WEBCHAT_TOKEN_REFRESH_LEAD_MS)).toBe(
      true,
    )
    expect(isWebchatTokenDue(0, 10 * TTL_MS)).toBe(true)
  })

  test("never due within a minute of arrival; a clock jump back restarts the count", () => {
    expect(webchatTokenRefreshDelayMs(0, 0)).toBeGreaterThanOrEqual(
      WEBCHAT_TOKEN_MIN_REFRESH_INTERVAL_MS,
    )
    expect(
      isWebchatTokenDue(0, WEBCHAT_TOKEN_MIN_REFRESH_INTERVAL_MS - 1),
    ).toBe(false)
    expect(webchatTokenRefreshDelayMs(10_000, 0)).toBe(
      TTL_MS - WEBCHAT_TOKEN_REFRESH_LEAD_MS,
    )
    expect(webchatTokenRefreshDelayMs(Number.NaN, 0)).toBe(
      TTL_MS - WEBCHAT_TOKEN_REFRESH_LEAD_MS,
    )
  })

  test("the server mints with the same TTL the client times against", async () => {
    const token = await mint("shop.example")
    const payload = await readWebchatAccessToken(token)
    expect((payload?.exp ?? 0) * 1000 - T0.getTime()).toBe(TTL_MS)
  })
})

describe("guest session store refresh", () => {
  const config = { id: CHAT, workspaceId: WS, persistentMenus: [] } as never
  const storeWith = (token: string | null = "old-token") => {
    const store = createGuestSessionStore(
      config,
      token,
      undefined,
      "shop.example",
    )
    store.setState({
      guestConversationId: "123:0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f",
    })
    return store
  }
  const forbidden = () =>
    Object.assign(new Error("Forbidden"), { response: { status: 403 } })

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  test("one request at a time; the fresh token lands in the store", async () => {
    let resolve: (value: { accessToken: string }) => void = () => undefined
    const post = vi.spyOn(ky, "post").mockReturnValue({
      json: () =>
        new Promise((r) => {
          resolve = r
        }),
    } as never)
    const store = storeWith()
    const a = store.getState().refreshAccessToken()
    const b = store.getState().refreshAccessToken()
    expect(post).toHaveBeenCalledTimes(1)
    expect(post.mock.calls[0]?.[0]).toBe("/api/guest/token")
    resolve({ accessToken: "new-token" })
    expect(await a).toBe("refreshed")
    expect(await b).toBe("refreshed")
    expect(store.getState().accessToken).toBe("new-token")
  })

  test("refusals and failures are told apart; both keep the current token", async () => {
    const store = storeWith()
    const post = vi.spyOn(ky, "post")
    const answers: [unknown, string][] = [
      [Promise.resolve({ accessToken: null }), "refused"],
      [Promise.reject(forbidden()), "refused"],
      [
        Promise.reject(
          Object.assign(new Error("Bad"), { response: { status: 400 } }),
        ),
        "refused",
      ],
      [
        Promise.reject(
          Object.assign(new Error("Busy"), { response: { status: 429 } }),
        ),
        "failed",
      ],
      [Promise.reject(new TypeError("network")), "failed"],
    ]
    for (const [answer, outcome] of answers) {
      post.mockReturnValueOnce({ json: () => answer } as never)
      expect(await store.getState().refreshAccessToken()).toBe(outcome)
    }
    expect(store.getState().accessToken).toBe("old-token")
  })

  test("freshAccessToken refreshes only a due token", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(T0)
    const post = vi.spyOn(ky, "post").mockReturnValue({
      json: async () => ({ accessToken: "new-token" }),
    } as never)
    const store = storeWith()
    expect(await store.getState().freshAccessToken()).toBe("old-token")
    expect(post).not.toHaveBeenCalled()
    vi.setSystemTime(T0.getTime() + TOKEN_TTL_SECONDS * 1000)
    expect(await store.getState().freshAccessToken()).toBe("new-token")
    expect(post).toHaveBeenCalledTimes(1)
    // Just refreshed: not due again.
    expect(await store.getState().freshAccessToken()).toBe("new-token")
    expect(post).toHaveBeenCalledTimes(1)
  })

  test("no token or no guest id: nothing is sent", async () => {
    const post = vi.spyOn(ky, "post")
    expect(await storeWith(null).getState().refreshAccessToken()).toBe(
      "refused",
    )
    const store = storeWith()
    store.setState({ guestConversationId: null })
    expect(await store.getState().refreshAccessToken()).toBe("refused")
    expect(post).not.toHaveBeenCalled()
  })

  test("a history GET that 403s is retried once with the refreshed token", async () => {
    const get = vi
      .spyOn(ky, "get")
      .mockReturnValueOnce({ json: () => Promise.reject(forbidden()) } as never)
      .mockReturnValueOnce({
        json: async () => ({ data: [], nextCursor: null }),
      } as never)
    vi.spyOn(ky, "post").mockReturnValue({
      json: async () => ({ accessToken: "new-token" }),
    } as never)
    const store = storeWith()
    await store.getState().loadMoreMessages("guest", 20)
    expect(get).toHaveBeenCalledTimes(2)
    expect(get.mock.calls[1]?.[1]).toMatchObject({
      headers: { Authorization: "Bearer new-token" },
    })
  })

  test("a second 403 is thrown, not looped; a refused refresh throws the first", async () => {
    const get = vi
      .spyOn(ky, "get")
      .mockReturnValue({ json: () => Promise.reject(forbidden()) } as never)
    const post = vi.spyOn(ky, "post").mockReturnValue({
      json: async () => ({ accessToken: "new-token" }),
    } as never)
    const store = storeWith()
    await expect(
      store.getState().loadMoreMessages("guest", 20),
    ).rejects.toThrow("Forbidden")
    expect(get).toHaveBeenCalledTimes(2)
    expect(post).toHaveBeenCalledTimes(1)

    post.mockReturnValue({ json: async () => ({ accessToken: null }) } as never)
    get.mockClear()
    store.setState({ isLoadMoreMessage: false, hasNextMessagePage: true })
    await expect(
      store.getState().loadMoreMessages("guest", 20),
    ).rejects.toThrow("Forbidden")
    expect(get).toHaveBeenCalledTimes(1)
  })
})
