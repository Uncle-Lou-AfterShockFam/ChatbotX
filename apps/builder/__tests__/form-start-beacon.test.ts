// @vitest-environment node

import { expect, test, vi } from "vitest"
import { createFormStartBeacon } from "../src/features/forms/lib/start-beacon"

/** s224a A2-4: one beacon per page load, only for a personal link. */
test("fires once on the first interaction, with the token and keepalive", () => {
  const send = vi.fn(() => Promise.resolve())
  const mark = createFormStartBeacon({
    workspaceId: "11701868563365888",
    slug: "intake",
    formLinkToken: "sealed",
    send,
  })
  mark()
  mark()
  mark()
  expect(send).toHaveBeenCalledTimes(1)
  expect(send).toHaveBeenCalledWith(
    "/api/forms/11701868563365888/intake/start",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ k: "sealed" }),
      keepalive: true,
    }),
  )
})

test("an anonymous page (no token, or an empty one) never beacons", () => {
  const send = vi.fn(() => Promise.resolve())
  createFormStartBeacon({
    workspaceId: "1",
    slug: "s",
    formLinkToken: undefined,
    send,
  })()
  createFormStartBeacon({
    workspaceId: "1",
    slug: "s",
    formLinkToken: "",
    send,
  })()
  expect(send).not.toHaveBeenCalled()
})

test("a failing beacon is swallowed (the form keeps working)", async () => {
  const send = vi.fn(() => Promise.reject(new Error("offline")))
  const mark = createFormStartBeacon({
    workspaceId: "1",
    slug: "s",
    formLinkToken: "t",
    send,
  })
  expect(() => mark()).not.toThrow()
  await Promise.resolve()
  expect(send).toHaveBeenCalledTimes(1)
})
