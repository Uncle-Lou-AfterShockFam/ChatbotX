import { beforeEach, describe, expect, test, vi } from "vitest"

const { mockCount, mockFindById, mockAutoLink, mockStopForContact, mockWarn } =
  vi.hoisted(() => ({
    mockCount: vi.fn(),
    mockFindById: vi.fn(),
    mockAutoLink: vi.fn(),
    mockStopForContact: vi.fn(),
    mockWarn: vi.fn(),
  }))

vi.mock("@chatbotx.io/business", () => ({
  companyService: {
    countForWorkspace: mockCount,
    autoLinkContact: mockAutoLink,
  },
  contactService: { findById: mockFindById },
}))
vi.mock("@chatbotx.io/business/company-stop", () => ({
  stopCompanyForContact: mockStopForContact,
}))
vi.mock("../src/lib/logger", () => ({
  logger: { info: vi.fn(), warn: mockWarn, error: vi.fn() },
}))

const { handleCompanyStopOnReply } = await import(
  "../src/events/message/handlers/company-stop-on-reply"
)

const base = {
  workspaceId: "ws-1",
  contactInboxId: "ci-1",
  channel: "api",
  inboxId: "inbox-1",
  occurredAt: new Date("2026-09-23T00:00:00Z"),
}

describe("handleCompanyStopOnReply", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCount.mockResolvedValue(1)
    mockFindById.mockResolvedValue({
      id: "c-1",
      email: null,
      companyId: "co-1",
    })
    mockAutoLink.mockResolvedValue({ linked: false })
    mockStopForContact.mockResolvedValue({
      status: "stopped",
      companyId: "co-1",
      contactCount: 2,
    })
  })

  test("an outbound delivery echo (no origin) is ignored", async () => {
    await handleCompanyStopOnReply([{ ...base, contactId: "c-1" }])
    expect(mockCount).not.toHaveBeenCalled()
    expect(mockStopForContact).not.toHaveBeenCalled()
  })

  test("a workspace with no companies costs one count and nothing else", async () => {
    mockCount.mockResolvedValue(0)
    await handleCompanyStopOnReply([
      { ...base, contactId: "c-1", origin: "inbound" },
      { ...base, contactId: "c-2", origin: "inbound" },
    ])
    expect(mockCount).toHaveBeenCalledTimes(1)
    expect(mockFindById).not.toHaveBeenCalled()
  })

  test("a contact with a company is stopped once per batch", async () => {
    await handleCompanyStopOnReply([
      { ...base, contactId: "c-1", origin: "inbound" },
      { ...base, contactId: "c-1", origin: "inbound" },
    ])
    expect(mockStopForContact).toHaveBeenCalledTimes(1)
    expect(mockStopForContact).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      contactId: "c-1",
      reason: "contact_replied",
    })
    expect(mockAutoLink).not.toHaveBeenCalled()
  })

  test("a partial stop is logged as a warning with its failed phases", async () => {
    mockStopForContact.mockResolvedValue({
      status: "partial",
      companyId: "co-1",
      failedPhases: ["smart-delays"],
    })
    await handleCompanyStopOnReply([
      { ...base, contactId: "c-1", origin: "inbound" },
    ])
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "co-1",
        failedPhases: ["smart-delays"],
      }),
      "company-stop: inbound reply stopped the company only partially",
    )
  })

  test("a contact without a company is auto-linked first, then stopped when linked", async () => {
    mockFindById.mockResolvedValue({
      id: "c-1",
      email: "lou@acme.com",
      companyId: null,
    })
    mockAutoLink.mockResolvedValue({ linked: true, companyId: "co-1" })
    await handleCompanyStopOnReply([
      { ...base, contactId: "c-1", origin: "inbound" },
    ])
    expect(mockAutoLink).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      contactId: "c-1",
      email: "lou@acme.com",
    })
    expect(mockStopForContact).toHaveBeenCalledTimes(1)
  })

  test("falls back to an email-shaped sourceId when the contact has no email", async () => {
    mockFindById.mockResolvedValue({ id: "c-1", email: null, companyId: null })
    await handleCompanyStopOnReply([
      { ...base, contactId: "c-1", origin: "inbound", sourceId: "x@acme.com" },
    ])
    expect(mockAutoLink).toHaveBeenCalledWith(
      expect.objectContaining({ email: "x@acme.com" }),
    )
    expect(mockStopForContact).not.toHaveBeenCalled()
  })

  test("a phone sourceId never auto-links and never stops", async () => {
    mockFindById.mockResolvedValue({ id: "c-1", email: null, companyId: null })
    await handleCompanyStopOnReply([
      {
        ...base,
        contactId: "c-1",
        origin: "inbound",
        sourceId: "+12154075123",
      },
    ])
    expect(mockAutoLink).toHaveBeenCalledWith(
      expect.objectContaining({ email: null }),
    )
    expect(mockStopForContact).not.toHaveBeenCalled()
  })

  test("an unknown contact is skipped", async () => {
    mockFindById.mockResolvedValue(undefined)
    await handleCompanyStopOnReply([
      { ...base, contactId: "c-9", origin: "inbound" },
    ])
    expect(mockStopForContact).not.toHaveBeenCalled()
  })

  test("a failure on one payload is logged and the next payload still runs", async () => {
    mockStopForContact
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ status: "already_stopped", companyId: "co-1" })
    await handleCompanyStopOnReply([
      { ...base, contactId: "c-1", origin: "inbound" },
      { ...base, contactId: "c-2", origin: "inbound" },
    ])
    expect(mockStopForContact).toHaveBeenCalledTimes(2)
    expect(mockWarn).toHaveBeenCalledTimes(1)
  })
})
