import { describe, expect, test } from "vitest"
import { signAppointmentToken } from "../src/appointment-token-utils"
import { signDynamicImageToken } from "../src/dynamic-image-token"
import {
  contactFromFormLink,
  FORM_LINK_TOKEN_MAX_TTL_MS,
  FORM_LINK_TOKEN_TTL_MS,
  signFormLinkToken,
  verifyFormLinkToken,
} from "../src/form-link-token"

const URL_SAFE_RE = /^[A-Za-z0-9\-_]+$/
const WS = "11701868563365888"
const PAYLOAD = { workspaceId: WS, formId: "form-1", contactId: "contact-1" }
const EXPECTED = { workspaceId: WS, formId: "form-1" }

describe("form link token (s220c A2-4)", () => {
  test("round-trips, URL-safe, and reveals no id in the clear", async () => {
    const token = await signFormLinkToken(PAYLOAD)
    expect(token).toMatch(URL_SAFE_RE)
    const decoded = Buffer.from(token, "base64url").toString("utf8")
    expect(decoded).not.toContain("contact-1")
    expect(decoded).not.toContain("form-1")
    await expect(verifyFormLinkToken(token)).resolves.toMatchObject(PAYLOAD)
    await expect(contactFromFormLink(token, EXPECTED)).resolves.toBe(
      "contact-1",
    )
  })

  test("lives 7 days by default; a caller can shorten it but never past 30 days", async () => {
    const before = Date.now()
    const week = await verifyFormLinkToken(await signFormLinkToken(PAYLOAD))
    expect(week.expiresAt).toBeGreaterThanOrEqual(
      before + FORM_LINK_TOKEN_TTL_MS,
    )
    const long = await verifyFormLinkToken(
      await signFormLinkToken(PAYLOAD, 365 * 24 * 60 * 60 * 1000),
    )
    expect(long.expiresAt).toBeLessThanOrEqual(
      Date.now() + FORM_LINK_TOKEN_MAX_TTL_MS,
    )
  })

  test("bound to ONE workspace and ONE form: another form or workspace reads anonymous", async () => {
    const token = await signFormLinkToken(PAYLOAD)
    await expect(
      contactFromFormLink(token, { workspaceId: WS, formId: "form-2" }),
    ).resolves.toBeNull()
    await expect(
      contactFromFormLink(token, { workspaceId: "999", formId: "form-1" }),
    ).resolves.toBeNull()
  })

  test("an expired, tampered or FOREIGN-PURPOSE token reads anonymous, never throws", async () => {
    const expired = await signAppointmentToken(
      { ...PAYLOAD, expiresAt: Date.now() - 1 },
      "form-link-token",
    )
    await expect(contactFromFormLink(expired, EXPECTED)).resolves.toBeNull()
    const good = await signFormLinkToken(PAYLOAD)
    const tampered = `${good.slice(0, -4)}${good.slice(-4) === "AAAA" ? "BBBB" : "AAAA"}`
    await expect(contactFromFormLink(tampered, EXPECTED)).resolves.toBeNull()
    // a dynamic-image token for the same contact is not a form link
    const image = await signDynamicImageToken({
      workspaceId: WS,
      dynamicImageId: "form-1",
      contactId: "contact-1",
      contactInboxId: "ci-1",
    })
    await expect(contactFromFormLink(image, EXPECTED)).resolves.toBeNull()
  })

  test("hostile inputs: non-strings, empty, oversized, garbage", async () => {
    for (const v of [
      undefined,
      null,
      42,
      {},
      [],
      "",
      "x".repeat(5000),
      "not-base64!",
      "e30",
    ]) {
      await expect(contactFromFormLink(v, EXPECTED)).resolves.toBeNull()
    }
  })

  test("a payload with an extra key never verifies (closed schema)", async () => {
    const extra = await signAppointmentToken(
      { ...PAYLOAD, expiresAt: Date.now() + 60_000, role: "admin" },
      "form-link-token",
    )
    await expect(contactFromFormLink(extra, EXPECTED)).resolves.toBeNull()
  })
})
