import { describe, expect, test, vi } from "vitest"
import { InstagramException } from "../src/exception"
import { webhookHandler } from "../src/handlers/webhook"
import { hmacSha256Hex } from "../src/lib/webhook"

const CLIENT_SECRET = "webhook-secret"
const UNAUTHORIZED = /^Unauthorized webhook: /
const BODY = JSON.stringify({ object: "instagram", entry: [] })

const call = (body: string, signature: string | null) => {
  const add = vi.fn()
  const headers: Record<string, string> = {}
  if (signature !== null) {
    headers["x-hub-signature-256"] = signature
  }
  const result = webhookHandler({
    config: { clientSecret: CLIENT_SECRET },
    req: new Request("https://example.test/webhook", {
      method: "POST",
      body,
      headers,
    }),
    queue: { add },
  } as never)
  return { add, result }
}

const sign = async (body: string) =>
  `sha256=${await hmacSha256Hex(CLIENT_SECRET, body)}`

// s231a: a signature failure is a 401 that no catch re-wraps into a 400.
describe("webhook signature failures", () => {
  test.each([
    ["an invalid signature", "sha256=deadbeef"],
    ["a malformed signature", "deadbeef"],
    ["a blank signature", ""],
    ["no signature header", null],
  ])("answers 401 for %s without enqueuing", async (_label, signature) => {
    const { add, result } = call(BODY, signature)
    const error = await result.catch((e: unknown) => e)

    expect(error).toBeInstanceOf(InstagramException)
    expect((error as InstagramException).httpStatusCode).toBe(401)
    expect((error as InstagramException).message).toMatch(UNAUTHORIZED)
    expect(add).not.toHaveBeenCalled()
  })

  test("a signature over another body is a 401", async () => {
    const { result } = call(BODY, await sign(`${BODY} `))
    const error = await result.catch((e: unknown) => e)

    expect((error as InstagramException).httpStatusCode).toBe(401)
  })

  test("an empty payload stays a 400", async () => {
    const { result } = call("", await sign(""))
    const error = await result.catch((e: unknown) => e)

    expect(error).toBeInstanceOf(InstagramException)
    expect((error as InstagramException).httpStatusCode).toBe(400)
  })

  test("a valid signature is still accepted", async () => {
    const { result } = call(BODY, await sign(BODY))

    await expect(result).resolves.toBe("ok")
  })
})
