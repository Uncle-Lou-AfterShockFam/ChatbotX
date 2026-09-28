import { describe, expect, test } from "vitest"
import { signAppointmentToken } from "../src/appointment-token-utils"
import { signDynamicImageToken } from "../src/dynamic-image-token"
import {
  mintQuickbooksOAuthNonce,
  QUICKBOOKS_OAUTH_STATE_TTL_MS,
  signQuickbooksOAuthState,
  verifyQuickbooksOAuthState,
} from "../src/quickbooks-oauth-state"

const USER = "11701868563300001"
const WORKSPACE = "11701868563365888"

async function minted(ttlMs?: number) {
  const nonce = mintQuickbooksOAuthNonce()
  const state = await signQuickbooksOAuthState(
    { workspaceId: WORKSPACE, userId: USER, nonce },
    ttlMs,
  )
  return { nonce, state }
}

describe("quickbooks oauth state (s214b)", () => {
  test("round-trips for the same user and cookie, reveals no id", async () => {
    const { nonce, state } = await minted()
    expect(Buffer.from(state, "base64url").toString("utf8")).not.toContain(
      WORKSPACE,
    )
    const verified = await verifyQuickbooksOAuthState({
      state,
      nonceCookie: nonce,
      userId: USER,
    })
    expect(verified).toMatchObject({ workspaceId: WORKSPACE, userId: USER })
    expect(verified?.expiresAt).toBeLessThanOrEqual(
      Date.now() + QUICKBOOKS_OAUTH_STATE_TTL_MS,
    )
  })

  test("refuses another user's state (a replayed code)", async () => {
    const { nonce, state } = await minted()
    await expect(
      verifyQuickbooksOAuthState({ state, nonceCookie: nonce, userId: "9" }),
    ).resolves.toBeNull()
  })

  test("refuses a nonce that is not the cookie's", async () => {
    const { state } = await minted()
    await expect(
      verifyQuickbooksOAuthState({
        state,
        nonceCookie: mintQuickbooksOAuthNonce(),
        userId: USER,
      }),
    ).resolves.toBeNull()
  })

  test("refuses an expired state", async () => {
    const { nonce, state } = await minted(-1)
    await expect(
      verifyQuickbooksOAuthState({ state, nonceCookie: nonce, userId: USER }),
    ).resolves.toBeNull()
  })

  test("refuses a tampered state", async () => {
    const { nonce, state } = await minted()
    const json = JSON.parse(Buffer.from(state, "base64url").toString("utf8"))
    json.text = `${json.text.slice(0, -2)}${json.text.endsWith("00") ? "11" : "00"}`
    const tampered = Buffer.from(JSON.stringify(json)).toString("base64url")
    await expect(
      verifyQuickbooksOAuthState({
        state: tampered,
        nonceCookie: nonce,
        userId: USER,
      }),
    ).resolves.toBeNull()
  })

  test("refuses a token minted for another purpose", async () => {
    const nonce = mintQuickbooksOAuthNonce()
    const other = await signDynamicImageToken({
      workspaceId: WORKSPACE,
      dynamicImageId: "1",
      contactId: "2",
      contactInboxId: "3",
    })
    await expect(
      verifyQuickbooksOAuthState({
        state: other,
        nonceCookie: nonce,
        userId: USER,
      }),
    ).resolves.toBeNull()
  })

  test("refuses unknown payload keys (closed schema)", async () => {
    const nonce = mintQuickbooksOAuthNonce()
    const state = await signAppointmentToken(
      {
        workspaceId: WORKSPACE,
        userId: USER,
        nonce,
        expiresAt: Date.now() + 60_000,
        admin: true,
      },
      "quickbooks-oauth-state",
    )
    await expect(
      verifyQuickbooksOAuthState({ state, nonceCookie: nonce, userId: USER }),
    ).resolves.toBeNull()
  })

  test.each([
    undefined,
    null,
    42,
    "",
    "x".repeat(4097),
    "not-base64-json",
  ])("refuses a non-state %#", async (state) => {
    await expect(
      verifyQuickbooksOAuthState({
        state,
        nonceCookie: mintQuickbooksOAuthNonce(),
        userId: USER,
      }),
    ).resolves.toBeNull()
  })

  test.each([
    undefined,
    null,
    "",
    "short",
    "x".repeat(44),
    {},
  ])("refuses a missing or malformed cookie %#", async (cookie) => {
    const { state } = await minted()
    await expect(
      verifyQuickbooksOAuthState({ state, nonceCookie: cookie, userId: USER }),
    ).resolves.toBeNull()
  })

  test("fuzz: random strings never verify", async () => {
    const nonce = mintQuickbooksOAuthNonce()
    for (let i = 0; i < 200; i++) {
      const junk = Buffer.from(
        Array.from({ length: 1 + (i % 300) }, () =>
          Math.floor(Math.random() * 256),
        ),
      ).toString(i % 2 ? "base64url" : "latin1")
      await expect(
        verifyQuickbooksOAuthState({
          state: junk,
          nonceCookie: nonce,
          userId: USER,
        }),
      ).resolves.toBeNull()
    }
  })
})
