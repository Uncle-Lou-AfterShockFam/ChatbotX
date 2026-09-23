import { beforeEach, describe, expect, test, vi } from "vitest"

const { mockFindName, mockResolveStopTag, mockStopForContact } = vi.hoisted(
  () => ({
    mockFindName: vi.fn(),
    mockResolveStopTag: vi.fn(),
    mockStopForContact: vi.fn(),
  }),
)

vi.mock("@chatbotx.io/business", () => ({
  companyService: { resolveStopTagName: mockResolveStopTag },
  tagService: { findNameByIdForWorkspace: mockFindName },
}))
vi.mock("@chatbotx.io/business/company-stop", () => ({
  stopCompanyForContact: mockStopForContact,
}))
vi.mock("../src/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { runCompanyStopOnTag } = await import(
  "../src/integration/handlers/company-stop-on-tag"
)

describe("runCompanyStopOnTag", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockResolveStopTag.mockResolvedValue("company-stop")
    mockStopForContact.mockResolvedValue({
      status: "stopped",
      companyId: "co-1",
    })
  })

  test("a tag other than the stop tag is a no-op", async () => {
    mockFindName.mockResolvedValue("bt-clicked")
    await runCompanyStopOnTag({
      workspaceId: "ws-1",
      contactId: "c-1",
      tagId: "t-1",
    })
    expect(mockStopForContact).not.toHaveBeenCalled()
  })

  test("an unknown (or deleted) tag is a no-op", async () => {
    mockFindName.mockResolvedValue(null)
    await runCompanyStopOnTag({
      workspaceId: "ws-1",
      contactId: "c-1",
      tagId: "t-1",
    })
    expect(mockStopForContact).not.toHaveBeenCalled()
  })

  test("the stop tag stops the contact's company", async () => {
    mockFindName.mockResolvedValue("company-stop")
    await runCompanyStopOnTag({
      workspaceId: "ws-1",
      contactId: "c-1",
      tagId: "t-1",
    })
    expect(mockStopForContact).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      contactId: "c-1",
      reason: "tag_applied",
    })
  })

  test("a workspace-configured stop tag name is honoured", async () => {
    mockResolveStopTag.mockResolvedValue("halt-all")
    mockFindName.mockResolvedValue("halt-all")
    await runCompanyStopOnTag({
      workspaceId: "ws-1",
      contactId: "c-1",
      tagId: "t-1",
    })
    expect(mockStopForContact).toHaveBeenCalledTimes(1)
  })
})
