import { beforeEach, describe, expect, test, vi } from "vitest"

vi.hoisted(() => {
  process.env.ENCRYPTION_KEY ??= "b".repeat(64)
})

const mocks = vi.hoisted(() => ({
  findValue: vi.fn(),
}))

vi.mock("../src/contact-custom-field/service", () => ({
  contactCustomFieldService: { findValue: mocks.findValue },
}))

vi.mock("../src/platform/settings", () => ({
  resolveTenantSettings: async () => ({
    storageUrl: "https://chat.example.org/storage",
  }),
}))

const { dynamicImageContactFileTag } = await import(
  "@chatbotx.io/encryption/dynamic-image-token"
)
const { getPublicFileUrl } = await import("@chatbotx.io/utils")
const { dynamicImageService } = await import("../src/dynamic-image/service")

const IMAGE = { id: "img-1", workspaceId: "ws-1", customFieldId: "cf-1" }
const tag = dynamicImageContactFileTag({
  workspaceId: "ws-1",
  dynamicImageId: "img-1",
  contactId: "contact-1",
})
const OWN = getPublicFileUrl(
  `public/space/ws-1/dynamic-images/img-1/contacts/contact-1-${tag}.png`,
  "https://chat.example.org/storage",
)

const cached = (value: string | null) => {
  mocks.findValue.mockResolvedValue(value)
  return dynamicImageService.findCachedUrlForContact({
    dynamicImage: IMAGE,
    contactId: "contact-1",
  })
}

describe("findCachedUrlForContact (s214: only the contact's own render)", () => {
  beforeEach(() => mocks.findValue.mockReset())

  test("accepts the contact's own tagged render, bare or with ?timestamp", async () => {
    expect(await cached(OWN)).toBe(OWN)
    expect(await cached(`${OWN}?timestamp=3`)).toBe(`${OWN}?timestamp=3`)
  })

  test.each([
    ["an arbitrary URL", "https://evil.example.com/x.png"],
    ["the old guessable path", OWN.replace(`-${tag}`, "")],
    ["another contact's render", OWN.replace("contact-1-", "contact-2-")],
    ["a suffix trick", `${OWN}.evil.com/x`],
    ["a javascript: value", "javascript:alert(1)"],
    ["an empty value", ""],
  ])("refuses %s", async (_label, value) => {
    expect(await cached(value)).toBeNull()
  })

  test("no cache field means no lookup", async () => {
    expect(
      await dynamicImageService.findCachedUrlForContact({
        dynamicImage: { ...IMAGE, customFieldId: null },
        contactId: "contact-1",
      }),
    ).toBeNull()
    expect(mocks.findValue).not.toHaveBeenCalled()
  })

  test("the file tag keeps the ids' render path unguessable", () => {
    expect(OWN).toContain(`contact-1-${tag}.png`)
    expect(tag).toHaveLength(32)
  })
})
