import { beforeEach, describe, expect, test, vi } from "vitest"

const m = vi.hoisted(() => ({
  personalLink: vi.fn(),
  resolveTenantSettings: vi.fn(),
}))
vi.mock("@chatbotx.io/business", () => ({
  resolveTenantSettings: m.resolveTenantSettings,
}))
vi.mock("@chatbotx.io/business/form", () => ({
  formService: { personalLink: m.personalLink },
}))

const { getFormLinkVariableFormId, resolveFormLinkVariable } = await import(
  "../src/form-link-variable"
)

const CTX = {
  contact: { id: "c-1", workspaceId: "11701868563365888" },
  contactInbox: null,
  workspace: null,
  customFieldsMap: new Map(),
  personalLinks: true,
} as never

beforeEach(() => {
  vi.clearAllMocks()
  m.resolveTenantSettings.mockResolvedValue({
    appUrl: "https://chat.example.org",
  })
  m.personalLink.mockResolvedValue(
    "https://chat.example.org/forms/1/intake?k=tok",
  )
})

describe("{{form_link:<formId>}} (s220c A2-4)", () => {
  test("parses only a numeric form id after the prefix", () => {
    expect(getFormLinkVariableFormId("form_link:11715813087330304")).toBe(
      "11715813087330304",
    )
    expect(getFormLinkVariableFormId("form_link: 42 ")).toBe("42")
    for (const bad of [
      "form_link:",
      "form_link:abc",
      "form_link:1;drop",
      "form_link:12345678901234567890",
      "coupon:1",
    ]) {
      expect(getFormLinkVariableFormId(bad)).toBeNull()
    }
  })

  test("mints the contact's personal link at send time with the tenant app URL", async () => {
    await expect(resolveFormLinkVariable(CTX, "form_link:42")).resolves.toBe(
      "https://chat.example.org/forms/1/intake?k=tok",
    )
    expect(m.personalLink).toHaveBeenCalledWith({
      workspaceId: "11701868563365888",
      formId: "42",
      contactId: "c-1",
      appUrl: "https://chat.example.org",
    })
  })

  test("FAIL CLOSED: without the direct-send opt-in (comment replies, Sheets, AI prompts, HTTP steps) no token is minted", async () => {
    for (const ctx of [
      { ...(CTX as object), personalLinks: false },
      { ...(CTX as object), personalLinks: undefined },
    ]) {
      await expect(
        resolveFormLinkVariable(ctx as never, "form_link:42"),
      ).resolves.toBe("")
    }
    expect(m.personalLink).not.toHaveBeenCalled()
    expect(m.resolveTenantSettings).not.toHaveBeenCalled()
  })

  test("a form the page would not serve, a bad id or no contact resolves to empty (never a dead link)", async () => {
    m.personalLink.mockResolvedValue(null)
    await expect(resolveFormLinkVariable(CTX, "form_link:42")).resolves.toBe("")
    m.personalLink.mockClear()
    await expect(resolveFormLinkVariable(CTX, "form_link:x")).resolves.toBe("")
    await expect(
      resolveFormLinkVariable(
        { ...(CTX as object), contact: null } as never,
        "form_link:42",
      ),
    ).resolves.toBe("")
    expect(m.personalLink).not.toHaveBeenCalled()
  })
})
