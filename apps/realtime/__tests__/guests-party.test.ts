import { signGuestSecret } from "@chatbotx.io/partysocket-config/guest-secret"
import type * as Party from "partykit/server"
import { describe, expect, test, vi } from "vitest"

const BROADCAST_SECRET = "s".repeat(32)

vi.mock("../src/env", () => ({
  env: { REALTIME_BROADCAST_SECRET: "s".repeat(32) },
}))

import GuestConversationParty from "../src/parties/guests"

const ROOM = "11701868563365888:0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f"

const connect = async (roomId: string, query = "") => {
  const req = new Request(
    `http://realtime.test/parties/guests/${roomId}${query}`,
  ) as unknown as Party.Request
  return {
    req,
    result: await GuestConversationParty.onBeforeConnect(req, {
      id: roomId,
    } as unknown as Party.Lobby),
  }
}

const expectRefused = (result: unknown) => {
  expect(result).toBeInstanceOf(Response)
  expect((result as Response).status).toBe(403)
}

describe("guests party connect gate (s213 + s215)", () => {
  test("a minted room with its own secret connects", async () => {
    const secret = await signGuestSecret(ROOM, BROADCAST_SECRET)
    const { req, result } = await connect(ROOM, `?k=${secret}`)
    expect(result).toBe(req)
  })

  test("the id alone (no `k`) is refused: it is shown by the API and exports", async () => {
    expectRefused((await connect(ROOM)).result)
    expectRefused((await connect(ROOM, "?k=")).result)
  })

  test("another room's secret, a secret under another key, and garbage are refused", async () => {
    const other = await signGuestSecret(
      "11701868563365888:1f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f",
      BROADCAST_SECRET,
    )
    const wrongKey = await signGuestSecret(ROOM, "t".repeat(32))
    for (const k of [other, wrongKey, "0".repeat(64), "x".repeat(4096)]) {
      expectRefused((await connect(ROOM, `?k=${k}`)).result)
    }
  })

  test.each([
    ["a legacy digits-only id", "11616773281153025"],
    ["a non-uuid suffix", "11701868563365888:guest-1"],
    ["an empty room", ""],
    ["a percent-encoded colon", "1%3A0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f"],
  ])("%s is refused with 403 before any socket opens", async (_, roomId) => {
    expectRefused((await connect(roomId, `?k=${"0".repeat(64)}`)).result)
  })
})
