import type * as Party from "partykit/server"
import { describe, expect, test, vi } from "vitest"

vi.mock("../src/env", () => ({
  env: { REALTIME_BROADCAST_SECRET: "s".repeat(32) },
}))

import GuestConversationParty from "../src/parties/guests"

const connect = (roomId: string) => {
  const req = new Request(
    `http://realtime.test/parties/guests/${roomId}`,
  ) as unknown as Party.Request
  return {
    req,
    result: GuestConversationParty.onBeforeConnect(req, {
      id: roomId,
    } as unknown as Party.Lobby),
  }
}

describe("guests party connect gate (s213)", () => {
  test("a minted `<workspaceId>:<uuid>` room connects", () => {
    const { req, result } = connect(
      "11701868563365888:0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f",
    )
    expect(result).toBe(req)
  })

  test.each([
    ["a legacy digits-only id", "11616773281153025"],
    ["a non-uuid suffix", "11701868563365888:guest-1"],
    ["an empty room", ""],
    ["a percent-encoded colon", "1%3A0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f"],
  ])("%s is refused with 403 before any socket opens", (_, roomId) => {
    const { result } = connect(roomId)
    expect(result).toBeInstanceOf(Response)
    expect((result as Response).status).toBe(403)
  })
})
