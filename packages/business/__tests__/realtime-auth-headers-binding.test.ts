import {
  REALTIME_TOKEN_PURPOSE,
  verifyRealtimeToken,
} from "@chatbotx.io/partysocket-config/auth"
import { describe, expect, test } from "vitest"
import {
  buildGetRealtimeAuthHeaders,
  isRealtimeTargetOfWorkspace,
} from "../src/integration-context/build-context"

const SECRET = "s".repeat(32)
const WS = "11701868563365888"
const MINTED = `${WS}:0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f`

// s213: the broadcast secret is global, so the signer binds every audience to
// the workspace the integration context was built for.
describe("getRealtimeAuthHeaders is bound to the context workspace", () => {
  const sign = buildGetRealtimeAuthHeaders(SECRET, WS)

  test("signs this workspace's minted guest room", async () => {
    const headers = await sign({ kind: "guest", id: MINTED })
    const token = headers.Authorization.slice("Bearer ".length)
    await expect(
      verifyRealtimeToken(
        token,
        { kind: "guest", id: MINTED },
        REALTIME_TOKEN_PURPOSE.broadcast,
        SECRET,
      ),
    ).resolves.toBeTruthy()
  })

  test("signs this workspace's own room", async () => {
    await expect(sign({ kind: "workspace", id: WS })).resolves.toHaveProperty(
      "Authorization",
    )
  })

  test.each([
    [
      "another workspace's minted guest id (CSV import)",
      { kind: "guest", id: "9:0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f" },
    ],
    [
      "a digits-only guest sourceId (API / passive upsert)",
      { kind: "guest", id: "11709523831537664" },
    ],
    ["a path-shaped guest id", { kind: "guest", id: `../workspaces/${WS}` }],
    ["another workspace's room", { kind: "workspace", id: "9" }],
    ["an unknown kind", { kind: "member", id: WS }],
  ] as const)("refuses %s with a 403, signing nothing", async (_, target) => {
    await expect(sign(target as never)).rejects.toMatchObject({
      code: "realtimeTargetRefused",
      httpStatusCode: 403,
    })
  })

  test("isRealtimeTargetOfWorkspace fails closed on an empty workspace", () => {
    expect(isRealtimeTargetOfWorkspace({ kind: "workspace", id: "" }, "")).toBe(
      false,
    )
    expect(isRealtimeTargetOfWorkspace({ kind: "guest", id: MINTED }, "")).toBe(
      false,
    )
  })
})
