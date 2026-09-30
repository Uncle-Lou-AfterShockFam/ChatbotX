// @vitest-environment node

import { describe, expect, test } from "vitest"
import { GET } from "../src/app/api/zalo-verifier/[verifier]/route"

const TOKEN_SHAPE = /^[A-Za-z0-9_-]+$/

const serve = (verifier: unknown) =>
  GET({} as never, { params: Promise.resolve({ verifier }) as never })

describe("zalo verifier route (s231a)", () => {
  test("a verifier-shaped token is served in the meta tag with a locked-down page", async () => {
    const response = await serve("Ab3_x-9Zq")

    expect(response.status).toBe(200)
    expect(await response.text()).toContain(
      '<meta property="zalo-platform-site-verification" content="Ab3_x-9Zq" />',
    )
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    )
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    expect(response.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    )
  })

  test.each([
    ['"><script>alert(1)</script>'],
    ['x" onload="alert(1)'],
    ["x'y"],
    ["<svg/onload=alert(1)>"],
    ["a b"],
    ["a/b"],
    ["a.html"],
    ["tökén"],
    ["x".repeat(129)],
    [""],
    [undefined],
    [null],
    [["a"]],
  ])("rejects %j with a plain 404 that never echoes it", async (verifier) => {
    const response = await serve(verifier)
    const body = await response.text()

    expect(response.status).toBe(404)
    expect(body).toBe("Not found")
    expect(response.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8",
    )
  })

  test("fuzz: no random input breaks out of the attribute", async () => {
    const alphabet = `abcXYZ019_-"'<>&/= \t\n%;()`
    let seed = 231
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed
    }

    for (let run = 0; run < 500; run++) {
      const length = (next() % 40) + 1
      let verifier = ""
      for (let i = 0; i < length; i++) {
        verifier += alphabet[next() % alphabet.length]
      }

      const response = await serve(verifier)
      const body = await response.text()

      if (response.status === 200) {
        expect(verifier).toMatch(TOKEN_SHAPE)
        expect(body).toContain(`content="${verifier}"`)
      } else {
        expect(response.status).toBe(404)
        expect(body).toBe("Not found")
      }
      expect(body).not.toContain("<script")
      expect(body).not.toContain("<svg")
    }
  })
})
