// @vitest-environment node

import { expect, test, vi } from "vitest"
import { createFormStartBeacon } from "../src/features/forms/lib/start-beacon"

const UUID_RE = /^[0-9a-f-]{36}$/

/** s224a A2-4: one beacon per page load, only for a personal link. */
test("fires once on the first interaction, with the token, the page load's id and keepalive", () => {
  const send = vi.fn(() => Promise.resolve())
  const visit = createFormStartBeacon({
    workspaceId: "11701868563365888",
    slug: "intake",
    formLinkToken: "sealed",
    send,
    newId: () => "0b7c6c5e-1d7b-4a4f-9e7d-2f3c1a9b8c7d",
  })
  expect(visit.interactionId).toBe("0b7c6c5e-1d7b-4a4f-9e7d-2f3c1a9b8c7d")
  visit.start()
  visit.start()
  visit.start()
  expect(send).toHaveBeenCalledTimes(1)
  expect(send).toHaveBeenCalledWith(
    "/api/forms/11701868563365888/intake/start",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        k: "sealed",
        v: "0b7c6c5e-1d7b-4a4f-9e7d-2f3c1a9b8c7d",
      }),
      keepalive: true,
    }),
  )
})

test("each page load gets its own id (the default is a random uuid)", () => {
  const a = createFormStartBeacon({
    workspaceId: "1",
    slug: "s",
    formLinkToken: "t",
  })
  const b = createFormStartBeacon({
    workspaceId: "1",
    slug: "s",
    formLinkToken: "t",
  })
  expect(a.interactionId).toMatch(UUID_RE)
  expect(a.interactionId).not.toBe(b.interactionId)
})

test("an anonymous page (no token, or an empty one) never beacons", () => {
  const send = vi.fn(() => Promise.resolve())
  createFormStartBeacon({
    workspaceId: "1",
    slug: "s",
    formLinkToken: undefined,
    send,
  }).start()
  createFormStartBeacon({
    workspaceId: "1",
    slug: "s",
    formLinkToken: "",
    send,
  }).start()
  expect(send).not.toHaveBeenCalled()
})

test("a failing beacon is swallowed (the form keeps working)", async () => {
  const send = vi.fn(() => Promise.reject(new Error("offline")))
  const visit = createFormStartBeacon({
    workspaceId: "1",
    slug: "s",
    formLinkToken: "t",
    send,
  })
  expect(() => visit.start()).not.toThrow()
  await Promise.resolve()
  expect(send).toHaveBeenCalledTimes(1)
})
