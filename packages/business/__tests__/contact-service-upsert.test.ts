import { beforeEach, describe, expect, test, vi } from "vitest"

const {
  contactFindFirst,
  findOrFail,
  invalidateCacheByTags,
  insertedRows,
  workspaceFind,
} = vi.hoisted(() => ({
  contactFindFirst: vi.fn(),
  findOrFail: vi.fn(),
  invalidateCacheByTags: vi.fn().mockResolvedValue(undefined),
  insertedRows: [] as Record<string, unknown>[],
  workspaceFind: vi.fn(),
}))

const makeInsert = () => ({
  values: (row: Record<string, unknown>) => {
    insertedRows.push(row)
    return {
      returning: () =>
        Promise.resolve([
          {
            id: "source" in row ? "ci-1" : "contact-1",
            contactId: "contact-1",
            createdAt: new Date("2026-06-01T00:00:00.000Z"),
            ...row,
          },
        ]),
    }
  },
})

vi.mock("@chatbotx.io/database/client", () => ({
  and: (...args: unknown[]) => ({ __and: args }),
  db: {
    query: {
      contactModel: {
        findFirst: contactFindFirst,
      },
    },
  },
  eq: (column: unknown, value: unknown) => ({ __eq: [column, value] }),
  findOrFail,
  inArray: (column: unknown, values: unknown[]) => ({
    __inArray: [column, values],
  }),
}))

vi.mock("@chatbotx.io/redis", () => ({
  invalidateCacheByTags,
  withCache: vi.fn((_key: string, fn: () => unknown) => fn()),
}))

vi.mock("@chatbotx.io/event-bus", () => ({
  emit: vi.fn(),
}))

vi.mock("@chatbotx.io/events", () => ({
  emitContactCreated: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("@chatbotx.io/filesystem", () => ({
  uploadFileFromUrl: vi.fn(),
  UploadValidationError: class UploadValidationError extends Error {},
}))

vi.mock("@chatbotx.io/utils", async (importOriginal) => {
  const original = await importOriginal<typeof import("@chatbotx.io/utils")>()

  return {
    ...original,
    createId: vi.fn(() => "generated-id"),
  }
})

const createContactWithoutMac = vi.fn(
  async (args: {
    create: (tx: {
      insert: () => ReturnType<typeof makeInsert>
    }) => Promise<unknown>
  }) => args.create({ insert: makeInsert }),
)
vi.mock("../src/quota-enforcement/service", () => ({
  quotaEnforcementService: {
    createContactWithoutMac,
  },
}))

vi.mock("@chatbotx.io/analytics", () => ({
  macAnalyticsService: {},
}))

vi.mock("../src/user-quota/service", () => ({
  userQuotaService: {},
}))

vi.mock("../src/workspace/service", () => ({
  workspaceService: {
    find: workspaceFind,
  },
}))

const { contactService } = await import("../src/contact/service")
const { uploadFileFromUrl, UploadValidationError } = await import(
  "@chatbotx.io/filesystem"
)
const { outboundDownload } = await import("../src/net/outbound-fetch")
const { contactSources } = await import("@chatbotx.io/database/partials")
const { emitContactCreated } = await import("@chatbotx.io/events")

describe("contactService.upsertByIdentifier", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    insertedRows.length = 0
    contactFindFirst.mockResolvedValue(null)
    findOrFail.mockResolvedValue({ id: "webchat-inbox", channel: "webchat" })
    workspaceFind.mockResolvedValue({ id: "ws-1", ownerId: "owner-1" })
  })

  test("writes the caller-provided source to new ContactInbox rows", async () => {
    await contactService.upsertByIdentifier({
      workspaceId: "ws-1",
      identifier: "email:ada@example.com",
      source: contactSources.enum.api,
      data: { firstName: "Ada" },
    })

    expect(insertedRows).toContainEqual(
      expect.objectContaining({
        channel: "webchat",
        source: "api",
      }),
    )
  })

  test("a URL avatar is downloaded only through the SSRF-pinned fetch (s216)", async () => {
    vi.mocked(uploadFileFromUrl).mockResolvedValue({
      name: "a.png",
      originPath: "public/space/ws-1/contacts/generated-id/avatar/generated-id",
      size: 1,
    } as Awaited<ReturnType<typeof uploadFileFromUrl>>)
    const update = vi
      .spyOn(contactService, "update")
      .mockResolvedValue(
        {} as Awaited<ReturnType<typeof contactService.update>>,
      )

    await contactService.upsertByIdentifier({
      workspaceId: "ws-1",
      identifier: "email:ada@example.com",
      source: contactSources.enum.api,
      data: { firstName: "Ada" },
      avatar: "https://cdn.example.com/a.png",
    })

    expect(uploadFileFromUrl).toHaveBeenCalledWith(
      "https://cdn.example.com/a.png",
      "public/space/ws-1/contacts/generated-id/avatar/generated-id",
      { fetchImpl: outboundDownload },
    )
    update.mockRestore()
  })

  test("a refused avatar URL skips the avatar, never the contact (s216)", async () => {
    vi.mocked(uploadFileFromUrl).mockRejectedValue(
      new UploadValidationError("The provided URL is not allowed"),
    )
    const update = vi.spyOn(contactService, "update")

    const result = await contactService.upsertByIdentifier({
      workspaceId: "ws-1",
      identifier: "email:ada@example.com",
      source: contactSources.enum.api,
      data: { firstName: "Ada" },
      avatar: "http://169.254.169.254/latest/meta-data",
    })

    expect(result.isNew).toBe(true)
    expect(update).not.toHaveBeenCalled()
    update.mockRestore()
  })

  test("a storage outage while saving the avatar still fails loudly", async () => {
    const outage = new Error("connect ECONNREFUSED filesystem:9000")
    vi.mocked(uploadFileFromUrl).mockRejectedValue(outage)

    await expect(
      contactService.upsertByIdentifier({
        workspaceId: "ws-1",
        identifier: "email:ada@example.com",
        source: contactSources.enum.api,
        data: { firstName: "Ada" },
        avatar: "https://cdn.example.com/a.png",
      }),
    ).rejects.toBe(outage)
  })

  test("creates the contact via the no-MAC path, never the MAC-gated one", async () => {
    await contactService.upsertByIdentifier({
      workspaceId: "ws-1",
      identifier: "email:ada@example.com",
      source: contactSources.enum.api,
      data: { firstName: "Ada" },
    })

    expect(createContactWithoutMac).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: "owner-1", workspaceId: "ws-1" }),
    )
  })

  test("threads the newly-created ContactInbox id into emitContactCreated", async () => {
    await contactService.upsertByIdentifier({
      workspaceId: "ws-1",
      identifier: "email:ada@example.com",
      source: contactSources.enum.api,
      data: { firstName: "Ada" },
    })

    // makeInsert returns id "ci-1" for the ContactInbox row (no `id` field in
    // its insert values, so the mock's synthetic id survives the `...row`
    // spread) — this asserts the trigger-attribution fix threads THAT id,
    // not the contact's own id, as the trailing arg.
    expect(emitContactCreated).toHaveBeenCalledWith(
      "ws-1",
      "generated-id",
      "Ada",
      undefined,
      "ada@example.com",
      "ci-1",
    )
  })
})
