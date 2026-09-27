import { describe, expect, test } from "vitest"
import { signAppointmentToken } from "../src/appointment-token-utils"
import {
  DYNAMIC_IMAGE_TOKEN_TTL_MS,
  dynamicImageContactFileTag,
  signDynamicImageToken,
  verifyDynamicImageToken,
} from "../src/dynamic-image-token"
import { signMinigamePlayToken } from "../src/minigame-play-token"

const URL_SAFE_RE = /^[A-Za-z0-9\-_]+$/
const EXPIRED_RE = /expired/
const MISMATCH_RE = /mismatch/
const HEX32_RE = /^[0-9a-f]{32}$/

const PAYLOAD = {
  workspaceId: "11701868563365888",
  dynamicImageId: "img-1",
  contactId: "contact-1",
  contactInboxId: "contact-inbox-1",
}

describe("dynamic image token (s214)", () => {
  test("round-trips, URL-safe, and reveals no id in the clear", async () => {
    const token = await signDynamicImageToken(PAYLOAD)
    expect(token).toMatch(URL_SAFE_RE)
    const decoded = Buffer.from(token, "base64url").toString("utf8")
    expect(decoded).not.toContain("contact-1")
    expect(decoded).not.toContain("img-1")
    await expect(verifyDynamicImageToken(token)).resolves.toMatchObject(PAYLOAD)
  })

  test("expires after the 30-day default", async () => {
    const before = Date.now()
    const payload = await verifyDynamicImageToken(
      await signDynamicImageToken(PAYLOAD),
    )
    expect(payload.expiresAt).toBeGreaterThanOrEqual(
      before + DYNAMIC_IMAGE_TOKEN_TTL_MS,
    )
    expect(DYNAMIC_IMAGE_TOKEN_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000)
  })

  test("rejects an expired token", async () => {
    const token = await signDynamicImageToken(PAYLOAD, -1)
    await expect(verifyDynamicImageToken(token)).rejects.toThrow(EXPIRED_RE)
  })

  test("rejects a token minted for another purpose", async () => {
    const token = await signMinigamePlayToken({
      workspaceId: PAYLOAD.workspaceId,
      contactId: PAYLOAD.contactId,
      contactInboxId: PAYLOAD.contactInboxId,
    })
    await expect(verifyDynamicImageToken(token)).rejects.toThrow(MISMATCH_RE)
  })

  test("rejects unknown payload keys (closed schema)", async () => {
    const token = await signAppointmentToken(
      { ...PAYLOAD, expiresAt: Date.now() + 60_000, admin: true },
      "dynamic-image-token",
    )
    await expect(verifyDynamicImageToken(token)).rejects.toThrow()
  })

  test("rejects a tampered ciphertext", async () => {
    const token = await signDynamicImageToken(PAYLOAD)
    const blob = JSON.parse(Buffer.from(token, "base64url").toString("utf8"))
    const key = Object.keys(blob).find(
      (k) => typeof blob[k] === "string" && blob[k].length > 20,
    ) as string
    const value: string = blob[key]
    blob[key] = `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`
    const tampered = Buffer.from(JSON.stringify(blob)).toString("base64url")
    await expect(verifyDynamicImageToken(tampered)).rejects.toThrow()
  })

  test.each([
    "",
    "not-a-token",
    Buffer.from("{}").toString("base64url"),
    Buffer.from("null").toString("base64url"),
    "%%%",
  ])("rejects malformed input %j", async (input) => {
    await expect(verifyDynamicImageToken(input)).rejects.toThrow()
  })

  test("fuzz: random base64url strings never verify", async () => {
    for (let i = 0; i < 200; i++) {
      const bytes = Buffer.alloc(1 + Math.floor(Math.random() * 300))
      for (let j = 0; j < bytes.length; j++) {
        bytes[j] = Math.floor(Math.random() * 256)
      }
      await expect(
        verifyDynamicImageToken(bytes.toString("base64url")),
      ).rejects.toThrow()
    }
  })
})

describe("dynamicImageContactFileTag (s214)", () => {
  const ids = {
    workspaceId: "ws-1",
    dynamicImageId: "img-1",
    contactId: "contact-1",
  }

  test("is deterministic, 32 hex chars, and free of the ids", () => {
    const tag = dynamicImageContactFileTag(ids)
    expect(tag).toMatch(HEX32_RE)
    expect(dynamicImageContactFileTag({ ...ids })).toBe(tag)
    expect(tag).not.toContain("contact")
  })

  test("differs per workspace, image and contact", () => {
    const tag = dynamicImageContactFileTag(ids)
    expect(
      dynamicImageContactFileTag({ ...ids, workspaceId: "ws-2" }),
    ).not.toBe(tag)
    expect(
      dynamicImageContactFileTag({ ...ids, dynamicImageId: "img-2" }),
    ).not.toBe(tag)
    expect(
      dynamicImageContactFileTag({ ...ids, contactId: "contact-2" }),
    ).not.toBe(tag)
  })
})
