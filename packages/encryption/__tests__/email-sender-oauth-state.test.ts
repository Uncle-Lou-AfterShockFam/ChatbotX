import { describe, expect, test } from "vitest"
import {
  mintEmailSenderOAuthNonce,
  signEmailSenderOAuthState,
  verifyEmailSenderOAuthState,
} from "../src/email-sender-oauth-state"
import {
  mintQuickbooksOAuthNonce,
  signQuickbooksOAuthState,
} from "../src/quickbooks-oauth-state"

const USER = "11701868563300001"
const WORKSPACE = "11701868563365888"
const LINE = "11701908099366912"

async function minted(extra: Record<string, string> = {}, ttlMs?: number) {
  const nonce = mintEmailSenderOAuthNonce()
  const state = await signEmailSenderOAuthState(
    {
      workspaceId: WORKSPACE,
      userId: USER,
      lineInboxId: LINE,
      fromName: "Lou",
      firstName: "Lou",
      lastName: "P",
      nonce,
      ...extra,
    },
    ttlMs,
  )
  return { nonce, state }
}

describe("email sender oauth state (s230b)", () => {
  test("round-trips the line and identity for the same user and cookie", async () => {
    const { nonce, state } = await minted()
    expect(Buffer.from(state, "base64url").toString("utf8")).not.toContain(LINE)
    await expect(
      verifyEmailSenderOAuthState({ state, nonceCookie: nonce, userId: USER }),
    ).resolves.toMatchObject({
      workspaceId: WORKSPACE,
      lineInboxId: LINE,
      fromName: "Lou",
    })
  })

  test("refuses another user, another nonce, an expired state and a missing cookie", async () => {
    const { nonce, state } = await minted()
    const verify = (nonceCookie: unknown, userId = USER) =>
      verifyEmailSenderOAuthState({ state, nonceCookie, userId })
    await expect(verify(nonce, "9")).resolves.toBeNull()
    await expect(verify(mintEmailSenderOAuthNonce())).resolves.toBeNull()
    await expect(verify(undefined)).resolves.toBeNull()
    await expect(verify("short")).resolves.toBeNull()
    const expired = await minted({}, -1)
    await expect(
      verifyEmailSenderOAuthState({
        state: expired.state,
        nonceCookie: expired.nonce,
        userId: USER,
      }),
    ).resolves.toBeNull()
  })

  test("refuses a QuickBooks state (another purpose) even with its own cookie", async () => {
    const nonce = mintQuickbooksOAuthNonce()
    const state = await signQuickbooksOAuthState({
      workspaceId: WORKSPACE,
      userId: USER,
      nonce,
    })
    await expect(
      verifyEmailSenderOAuthState({ state, nonceCookie: nonce, userId: USER }),
    ).resolves.toBeNull()
  })

  test("refuses a tampered, empty, non-string or oversized state", async () => {
    const { nonce, state } = await minted()
    const flipped = `${state.slice(0, -4)}${state.slice(-4) === "AAAA" ? "BBBB" : "AAAA"}`
    for (const bad of [flipped, "", 42, null, "a".repeat(9000)]) {
      await expect(
        verifyEmailSenderOAuthState({
          state: bad,
          nonceCookie: nonce,
          userId: USER,
        }),
      ).resolves.toBeNull()
    }
  })

  test("the longest identity (3 x 100 three-byte UTF-16 units) fits the state cap", async () => {
    // max(100) counts UTF-16 units; a BMP unit is at most 3 UTF-8 bytes.
    const long = "\u4e2d".repeat(100)
    const { nonce, state } = await minted({
      fromName: long,
      firstName: long,
      lastName: long,
    })
    expect(state.length).toBeLessThanOrEqual(8192)
    await expect(
      verifyEmailSenderOAuthState({ state, nonceCookie: nonce, userId: USER }),
    ).resolves.toMatchObject({ fromName: long })
  })

  test("sign refuses an unknown key or a non-numeric line id", async () => {
    const nonce = mintEmailSenderOAuthNonce()
    await expect(
      signEmailSenderOAuthState({
        workspaceId: WORKSPACE,
        userId: USER,
        lineInboxId: "abc",
        nonce,
      }),
    ).rejects.toThrow()
    await expect(
      signEmailSenderOAuthState({
        workspaceId: WORKSPACE,
        userId: USER,
        lineInboxId: LINE,
        nonce,
        // @ts-expect-error: the schema is closed
        extra: "x",
      }),
    ).rejects.toThrow()
  })
})
