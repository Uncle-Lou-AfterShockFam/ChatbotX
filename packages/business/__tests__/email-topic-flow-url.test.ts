import { encryptUtils } from "@chatbotx.io/encryption"
import { describe, expect, test, vi } from "vitest"
import {
  MAX_EMAIL_FLOW_TOKEN_LENGTH,
  signEmailFlowToken,
  verifyEmailFlowToken,
} from "../src/email-topic/flow-url"

const URL_SAFE = /^[A-Za-z0-9\-_]+$/
const input = {
  workspaceId: "11701868563365888",
  flowId: "11715155226574848",
  contactId: "11715763347521536",
  contactInboxId: "11715763347554304",
}

describe("email flow token (s222b)", () => {
  test("round-trips workspace, flow, optional node, contact and contact inbox; URL-safe", async () => {
    const token = await signEmailFlowToken(input)
    expect(token).toMatch(URL_SAFE)
    await expect(verifyEmailFlowToken(token)).resolves.toMatchObject({
      wid: input.workspaceId,
      fid: input.flowId,
      cid: input.contactId,
      ciid: input.contactInboxId,
    })
    const withNode = await verifyEmailFlowToken(
      await signEmailFlowToken({ ...input, nodeId: "11715155226574999" }),
    )
    expect(withNode.nid).toBe("11715155226574999")
    // Every link gets its own id: what "once per link" claims.
    const a = await verifyEmailFlowToken(await signEmailFlowToken(input))
    const b = await verifyEmailFlowToken(await signEmailFlowToken(input))
    expect(a.lid).not.toBe(b.lid)
  })

  test("s227a: a page-bound token carries its page link, its fixed link id, and never outlives the link", async () => {
    const linkId = "0b9f7c1e-2d3a-5b4c-8d6e-7f8091a2b3c4"
    const soon = new Date(Date.now() + 60_000)
    const payload = await verifyEmailFlowToken(
      await signEmailFlowToken({
        ...input,
        pageLink: { id: "4242", expiresAt: soon, linkId },
      }),
    )
    expect(payload).toMatchObject({ plid: "4242", lid: linkId })
    expect(payload.exp).toBe(soon.getTime())
    // A link longer than a year is still capped at the token's own year.
    const far = await verifyEmailFlowToken(
      await signEmailFlowToken({
        ...input,
        pageLink: {
          id: "4242",
          expiresAt: new Date(Date.now() + 5 * 365 * 86_400_000),
          linkId,
        },
      }),
    )
    expect(far.exp).toBeLessThanOrEqual(Date.now() + 366 * 86_400_000)
    // Already expired link: the token is dead on arrival.
    await expect(
      verifyEmailFlowToken(
        await signEmailFlowToken({
          ...input,
          pageLink: { id: "4242", expiresAt: new Date(Date.now() - 1), linkId },
        }),
      ),
    ).rejects.toThrow("expired")
    // A newsletter token has no page link.
    expect(
      (await verifyEmailFlowToken(await signEmailFlowToken(input))).plid,
    ).toBeUndefined()
  })

  test("a tampered, foreign, oversized or empty token is refused", async () => {
    const token = await signEmailFlowToken(input)
    const mid = Math.floor(token.length / 2)
    const tampered = `${token.slice(0, mid)}${token[mid] === "A" ? "B" : "A"}${token.slice(mid + 1)}`
    await expect(verifyEmailFlowToken(tampered)).rejects.toThrow()
    await expect(verifyEmailFlowToken("https://evil.test")).rejects.toThrow()
    await expect(verifyEmailFlowToken("")).rejects.toThrow("invalid length")
    await expect(
      verifyEmailFlowToken("a".repeat(MAX_EMAIL_FLOW_TOKEN_LENGTH + 1)),
    ).rejects.toThrow("invalid length")
  })

  test("a sealed object of another shape (e.g. a click payload) is refused: the schema is closed", async () => {
    const foreign = Buffer.from(
      JSON.stringify(
        await encryptUtils.encryptObject({
          url: "https://evil.test",
          exp: Date.now() + 60_000,
          workspaceId: input.workspaceId,
        }),
      ),
    ).toString("base64url")
    await expect(verifyEmailFlowToken(foreign)).rejects.toThrow()
    const extraKey = Buffer.from(
      JSON.stringify(
        await encryptUtils.encryptObject({
          wid: input.workspaceId,
          fid: input.flowId,
          cid: input.contactId,
          ciid: input.contactInboxId,
          lid: "5b4b4a52-4c4e-4d52-9a2b-1c2d3e4f5a6b",
          exp: Date.now() + 60_000,
          admin: true,
        }),
      ),
    ).toString("base64url")
    await expect(verifyEmailFlowToken(extraKey)).rejects.toThrow()
  })

  test("an expired token is refused", async () => {
    vi.useFakeTimers()
    try {
      const token = await signEmailFlowToken(input)
      vi.setSystemTime(Date.now() + 366 * 24 * 60 * 60 * 1000)
      await expect(verifyEmailFlowToken(token)).rejects.toThrow("expired")
    } finally {
      vi.useRealTimers()
    }
  })
})
