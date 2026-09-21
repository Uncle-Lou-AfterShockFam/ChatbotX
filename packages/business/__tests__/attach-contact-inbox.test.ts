import { beforeEach, describe, expect, it, vi } from "vitest"

const {
  mockFindOrFail,
  mockTransaction,
  mockInsertReturning,
  mockFindLatestBySource,
  mockInvalidateTracking,
  mockFindOrCreate,
  mockFindByIdOrFail,
  mockWorkspaceFind,
  mockCancelByInboxSource,
  mockDispatchAuditRecord,
  mockEmit,
  mockEmitContactCreated,
} = vi.hoisted(() => ({
  mockFindOrFail: vi.fn(),
  mockTransaction: vi.fn(),
  mockInsertReturning: vi.fn(),
  mockFindLatestBySource: vi.fn(),
  mockInvalidateTracking: vi.fn(() => Promise.resolve()),
  mockFindOrCreate: vi.fn(),
  mockFindByIdOrFail: vi.fn(),
  mockWorkspaceFind: vi.fn(),
  mockCancelByInboxSource: vi.fn(() => Promise.resolve()),
  mockDispatchAuditRecord: vi.fn(() => Promise.resolve()),
  mockEmit: vi.fn(() => Promise.resolve()),
  mockEmitContactCreated: vi.fn(() => Promise.resolve()),
}))

const tx = {
  insert: vi.fn(() => ({
    values: vi.fn(() => ({
      onConflictDoNothing: vi.fn(() => ({
        returning: mockInsertReturning,
      })),
    })),
  })),
}

vi.mock("@chatbotx.io/database/client", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return {
    ...original,
    db: { transaction: mockTransaction },
    findOrFail: mockFindOrFail,
  }
})
vi.mock("../src/contact-inbox/service", () => ({
  contactInboxService: {
    findLatestBySource: mockFindLatestBySource,
    invalidateTracking: mockInvalidateTracking,
  },
}))
vi.mock("../src/conversation/service", () => ({
  conversationService: { findOrCreate: mockFindOrCreate },
}))
vi.mock("../src/contact/service", () => ({
  contactService: { findByIdOrFail: mockFindByIdOrFail },
}))
vi.mock("../src/workspace/service", () => ({
  workspaceService: { find: mockWorkspaceFind },
}))
vi.mock("../src/message-cleanup/service", () => ({
  messageCleanupService: { cancelByInboxSource: mockCancelByInboxSource },
}))
vi.mock("../src/audit/dispatcher", () => ({
  dispatchAuditRecord: mockDispatchAuditRecord,
}))
vi.mock("@chatbotx.io/event-bus", () => ({ emit: mockEmit }))
vi.mock("@chatbotx.io/events", () => ({
  emitContactCreated: mockEmitContactCreated,
}))

const { attachContactToInbox, CONTACT_INBOX_OWNED_BY_ANOTHER_CONTACT } =
  await import("../src/contact/attach-inbox")
const { ChatbotXException } = await import("../src/errors")

const workspaceId = "ws-1"
const apiInbox = { id: "inbox-api", workspaceId, channel: "api", name: "GV" }
const contact = { id: "contact-1", workspaceId, phoneNumber: "+12154075123" }
const conversation = { id: "conv-1", contactId: contact.id }
const row = (contactId: string) => ({
  id: `ci-${contactId}`,
  contactId,
  inboxId: apiInbox.id,
  channel: "api",
  source: "api",
  sourceId: "+12154075123",
})

const expectException = async (
  promise: Promise<unknown>,
  code: string,
  status: number,
) => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(ChatbotXException)
  expect((error as ChatbotXException).code).toBe(code)
  expect((error as ChatbotXException).httpStatusCode).toBe(status)
}

describe("attachContactToInbox", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFindOrFail.mockResolvedValue(apiInbox)
    mockFindByIdOrFail.mockResolvedValue(contact)
    mockWorkspaceFind.mockResolvedValue({
      id: workspaceId,
      targetCountry: "US",
    })
    mockFindLatestBySource.mockResolvedValue(undefined)
    mockInsertReturning.mockResolvedValue([row(contact.id)])
    mockFindOrCreate.mockResolvedValue(conversation)
    mockTransaction.mockImplementation(async (fn: (t: unknown) => unknown) =>
      fn(tx),
    )
  })

  it("inserts an api identity keyed on the contact's E.164 phone and returns created: true", async () => {
    const result = await attachContactToInbox({
      workspaceId,
      contactId: contact.id,
      inboxId: apiInbox.id,
    })

    expect(result.created).toBe(true)
    expect(result.contactInbox).toEqual(row(contact.id))
    expect(result.conversation).toEqual(conversation)
    expect(result.inbox).toEqual(apiInbox)
    expect(mockFindOrFail).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId, id: apiInbox.id } }),
    )
    const values = (
      tx.insert.mock.results[0]?.value as { values: ReturnType<typeof vi.fn> }
    ).values
    expect(values).toHaveBeenCalledWith({
      originalContactId: contact.id,
      contactId: contact.id,
      inboxId: apiInbox.id,
      channel: "api",
      source: "api",
      sourceId: "+12154075123",
    })
    expect(mockCancelByInboxSource).toHaveBeenCalledWith({
      inboxId: apiInbox.id,
      sourceIds: ["+12154075123"],
      tx,
    })
    expect(mockFindOrCreate).toHaveBeenCalledWith({
      workspaceId,
      contactId: contact.id,
      sourceId: null,
      tx,
    })
    expect(mockInvalidateTracking).toHaveBeenCalledWith({
      cacheTags: [`contacts:${contact.id}:contact-inboxes`],
    })
    expect(mockDispatchAuditRecord).toHaveBeenCalledTimes(1)
  })

  it("normalises a local-format phone with the workspace country", async () => {
    mockFindByIdOrFail.mockResolvedValue({
      ...contact,
      phoneNumber: "(215) 407-5123",
    })

    await attachContactToInbox({
      workspaceId,
      contactId: contact.id,
      inboxId: apiInbox.id,
    })

    const values = (
      tx.insert.mock.results[0]?.value as { values: ReturnType<typeof vi.fn> }
    ).values
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: "+12154075123" }),
    )
  })

  it("is idempotent: the same identity on the same contact returns the row without inserting", async () => {
    mockFindLatestBySource.mockResolvedValue(row(contact.id))

    const result = await attachContactToInbox({
      workspaceId,
      contactId: contact.id,
      inboxId: apiInbox.id,
    })

    expect(result.created).toBe(false)
    expect(result.contactInbox).toEqual(row(contact.id))
    expect(tx.insert).not.toHaveBeenCalled()
    expect(mockFindOrCreate).toHaveBeenCalledTimes(1)
    expect(mockInvalidateTracking).not.toHaveBeenCalled()
    expect(mockDispatchAuditRecord).not.toHaveBeenCalled()
  })

  it("throws 409 when the identity belongs to another contact (pre-check)", async () => {
    mockFindLatestBySource.mockResolvedValue(row("contact-2"))

    await expectException(
      attachContactToInbox({
        workspaceId,
        contactId: contact.id,
        inboxId: apiInbox.id,
      }),
      CONTACT_INBOX_OWNED_BY_ANOTHER_CONTACT,
      409,
    )
    expect(mockTransaction).not.toHaveBeenCalled()
  })

  it("throws 409 when a lost race inserted the identity for another contact", async () => {
    mockInsertReturning.mockResolvedValue([])
    mockFindLatestBySource
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(row("contact-2"))

    await expectException(
      attachContactToInbox({
        workspaceId,
        contactId: contact.id,
        inboxId: apiInbox.id,
      }),
      CONTACT_INBOX_OWNED_BY_ANOTHER_CONTACT,
      409,
    )
    expect(mockCancelByInboxSource).not.toHaveBeenCalled()
  })

  it("returns the re-selected row with created: false when a lost race was the same contact", async () => {
    mockInsertReturning.mockResolvedValue([])
    mockFindLatestBySource
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(row(contact.id))

    const result = await attachContactToInbox({
      workspaceId,
      contactId: contact.id,
      inboxId: apiInbox.id,
    })

    expect(result.created).toBe(false)
    expect(result.contactInbox).toEqual(row(contact.id))
    expect(mockFindLatestBySource).toHaveBeenLastCalledWith(
      expect.objectContaining({ tx, inboxId: apiInbox.id }),
    )
    expect(mockDispatchAuditRecord).not.toHaveBeenCalled()
  })

  it("throws 422 when the contact has no phone and no sourceId was given", async () => {
    mockFindByIdOrFail.mockResolvedValue({ ...contact, phoneNumber: null })

    await expectException(
      attachContactToInbox({
        workspaceId,
        contactId: contact.id,
        inboxId: apiInbox.id,
      }),
      "validation",
      422,
    )
    expect(mockTransaction).not.toHaveBeenCalled()
  })

  it("throws 422 when the phone cannot be parsed", async () => {
    mockFindByIdOrFail.mockResolvedValue({ ...contact, phoneNumber: "nope" })
    mockWorkspaceFind.mockResolvedValue({
      id: workspaceId,
      targetCountry: null,
    })

    await expectException(
      attachContactToInbox({
        workspaceId,
        contactId: contact.id,
        inboxId: apiInbox.id,
      }),
      "validation",
      422,
    )
  })

  it("throws 422 for a non-api inbox", async () => {
    mockFindOrFail.mockResolvedValue({ ...apiInbox, channel: "instagram" })

    await expectException(
      attachContactToInbox({
        workspaceId,
        contactId: contact.id,
        inboxId: apiInbox.id,
      }),
      "validation",
      422,
    )
    expect(mockFindByIdOrFail).not.toHaveBeenCalled()
  })

  it("propagates the inbox lookup failure for an inbox outside the workspace", async () => {
    const notFound = new Error("Inbox not found")
    mockFindOrFail.mockRejectedValue(notFound)

    await expect(
      attachContactToInbox({
        workspaceId,
        contactId: contact.id,
        inboxId: "inbox-elsewhere",
      }),
    ).rejects.toBe(notFound)
  })

  it("uses an explicit sourceId verbatim (trimmed) and never consults the phone", async () => {
    mockFindByIdOrFail.mockResolvedValue({ ...contact, phoneNumber: null })

    await attachContactToInbox({
      workspaceId,
      contactId: contact.id,
      inboxId: apiInbox.id,
      sourceId: "  ext-42 ",
    })

    const values = (
      tx.insert.mock.results[0]?.value as { values: ReturnType<typeof vi.fn> }
    ).values
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: "ext-42" }),
    )
    expect(mockWorkspaceFind).not.toHaveBeenCalled()
  })

  it("normalises a phone-shaped explicit sourceId to E.164 (no divergence from the inbound key)", async () => {
    mockFindByIdOrFail.mockResolvedValue({ ...contact, phoneNumber: null })

    await attachContactToInbox({
      workspaceId,
      contactId: contact.id,
      inboxId: apiInbox.id,
      sourceId: "+1 (215) 407-5123",
    })

    const values = (
      tx.insert.mock.results[0]?.value as { values: ReturnType<typeof vi.fn> }
    ).values
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: "+12154075123" }),
    )
  })

  it("throws 422 for a phone-shaped explicit sourceId that cannot be parsed", async () => {
    mockWorkspaceFind.mockResolvedValue({
      id: workspaceId,
      targetCountry: null,
    })

    await expectException(
      attachContactToInbox({
        workspaceId,
        contactId: contact.id,
        inboxId: apiInbox.id,
        sourceId: "215 407 5123",
      }),
      "validation",
      422,
    )
    expect(mockTransaction).not.toHaveBeenCalled()
  })

  it("rejects a non-object input at the entry point", async () => {
    await expectException(
      attachContactToInbox(null as never),
      "validation",
      422,
    )
  })

  it("never emits a contact-created event on any path", async () => {
    await attachContactToInbox({
      workspaceId,
      contactId: contact.id,
      inboxId: apiInbox.id,
    })
    mockFindLatestBySource.mockResolvedValue(row(contact.id))
    await attachContactToInbox({
      workspaceId,
      contactId: contact.id,
      inboxId: apiInbox.id,
    })

    expect(mockEmitContactCreated).not.toHaveBeenCalled()
    expect(mockEmit).not.toHaveBeenCalled()
  })
})
