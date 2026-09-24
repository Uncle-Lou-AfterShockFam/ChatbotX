import { beforeEach, describe, expect, test, vi } from "vitest"

const {
  mockFindFirst,
  mockFindMany,
  mockCount,
  mockInsertReturning,
  mockUpdateReturning,
  mockDeleteReturning,
  mockSelectLimit,
  mockSelectWhere,
  mockInvalidate,
  mockWorkspaceFind,
  mockFindOrFail,
} = vi.hoisted(() => ({
  mockFindFirst: vi.fn(),
  mockFindMany: vi.fn(),
  mockCount: vi.fn(),
  mockInsertReturning: vi.fn(),
  mockUpdateReturning: vi.fn(),
  mockDeleteReturning: vi.fn(),
  mockSelectLimit: vi.fn(),
  mockSelectWhere: vi.fn(),
  mockInvalidate: vi.fn(),
  mockWorkspaceFind: vi.fn(),
  mockFindOrFail: vi.fn(),
}))

vi.mock("@chatbotx.io/database/client", () => {
  const selectChain: Record<string, unknown> = {}
  selectChain.from = () => selectChain
  selectChain.where = (...args: unknown[]) => {
    mockSelectWhere(...args)
    return selectChain
  }
  selectChain.limit = mockSelectLimit
  selectChain.groupBy = () => Promise.resolve([])
  const insertChain = { values: vi.fn(), returning: mockInsertReturning }
  insertChain.values.mockReturnValue(insertChain)
  const updateChain = {
    set: vi.fn(),
    where: vi.fn(),
    returning: mockUpdateReturning,
  }
  updateChain.set.mockReturnValue(updateChain)
  updateChain.where.mockReturnValue(updateChain)
  const deleteChain = { where: vi.fn(), returning: mockDeleteReturning }
  deleteChain.where.mockReturnValue(deleteChain)
  return {
    db: {
      query: {
        companyModel: { findFirst: mockFindFirst, findMany: mockFindMany },
      },
      $count: mockCount,
      insert: () => insertChain,
      update: () => updateChain,
      delete: () => deleteChain,
      select: () => selectChain,
    },
    and: vi.fn((...conditions: unknown[]) => ({ conditions })),
    eq: vi.fn((field: unknown, value: unknown) => ({ field, value })),
    inArray: vi.fn((field: unknown, values: unknown[]) => ({ field, values })),
    isNull: vi.fn((field: unknown) => ({ field, isNull: true })),
    sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    })),
    findOrFail: mockFindOrFail,
    relationsFilterToSQL: vi.fn(() => ({})),
  }
})
vi.mock("@chatbotx.io/database/utils", () => ({
  likeContains: (value: string) => `%${value}%`,
  parseOrderByAsObject: () => ({}),
  parsePagination: () => ({ limit: 20, offset: 0 }),
}))
vi.mock("@chatbotx.io/utils", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createId: () => "new-id",
}))
vi.mock("../src/contact/service", () => ({
  contactService: { invalidate: mockInvalidate },
}))
vi.mock("../src/workspace/service", () => ({
  workspaceService: { find: mockWorkspaceFind },
}))
vi.mock("../src/audit/dispatcher", () => ({
  dispatchAuditRecord: vi.fn(),
}))

const { companyService } = await import("../src/company/service")

const WS = "ws-1"

describe("companyService.create", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFindFirst.mockResolvedValue(undefined)
    mockInsertReturning.mockResolvedValue([{ id: "new-id", name: "Acme" }])
  })

  test("normalises domains and stores the trimmed name", async () => {
    const insertValues = vi.fn()
    const company = await companyService.create({
      workspaceId: WS,
      data: {
        name: "  Acme ",
        domains: ["https://www.Acme.com/x", "acme.com"],
      },
      tx: {
        query: { companyModel: { findFirst: mockFindFirst } },
        insert: () => ({
          values: (values: unknown) => {
            insertValues(values)
            return { returning: mockInsertReturning }
          },
        }),
      } as never,
    })
    expect(company.id).toBe("new-id")
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Acme",
        domains: ["acme.com"],
        stopOnReply: true,
      }),
    )
  })

  test("rejects a free-mail domain with a field-scoped validation error", async () => {
    await expect(
      companyService.create({
        workspaceId: WS,
        data: { name: "Acme", domains: ["gmail.com"] },
      }),
    ).rejects.toMatchObject({ code: "validation", field: "domains" })
  })

  test("rejects an empty name", async () => {
    await expect(
      companyService.create({ workspaceId: WS, data: { name: "   " } }),
    ).rejects.toMatchObject({ code: "validation", field: "name" })
  })

  test("rejects a taken name", async () => {
    mockFindFirst.mockResolvedValue({ id: "other" })
    await expect(
      companyService.create({ workspaceId: WS, data: { name: "Acme" } }),
    ).rejects.toMatchObject({ code: "nameTaken" })
  })
})

describe("companyService.autoLinkContact", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test.each([
    [null, "null email"],
    ["not-an-email", "not an email"],
    ["lou@gmail.com", "free-mail domain"],
  ])("%s -> not linked (%s) without touching the database", async (email) => {
    await expect(
      companyService.autoLinkContact({
        workspaceId: WS,
        contactId: "c-1",
        email,
      }),
    ).resolves.toEqual({ linked: false })
    expect(mockSelectLimit).not.toHaveBeenCalled()
  })

  test("no company owns the domain -> not linked", async () => {
    mockSelectLimit.mockResolvedValue([])
    await expect(
      companyService.autoLinkContact({
        workspaceId: WS,
        contactId: "c-1",
        email: "a@acme.com",
      }),
    ).resolves.toEqual({ linked: false })
    expect(mockUpdateReturning).not.toHaveBeenCalled()
  })

  test("already linked (companyId IS NULL predicate updates nothing) -> not linked", async () => {
    mockSelectLimit.mockResolvedValue([{ id: "company-1" }])
    mockUpdateReturning.mockResolvedValue([])
    await expect(
      companyService.autoLinkContact({
        workspaceId: WS,
        contactId: "c-1",
        email: "a@acme.com",
      }),
    ).resolves.toEqual({ linked: false })
    expect(mockInvalidate).not.toHaveBeenCalled()
  })

  test("links and invalidates the contact cache", async () => {
    mockSelectLimit.mockResolvedValue([{ id: "company-1" }])
    mockUpdateReturning.mockResolvedValue([{ id: "c-1" }])
    await expect(
      companyService.autoLinkContact({
        workspaceId: WS,
        contactId: "c-1",
        email: "A@Acme.COM",
      }),
    ).resolves.toEqual({ linked: true, companyId: "company-1" })
    expect(mockInvalidate).toHaveBeenCalledWith({
      workspaceId: WS,
      ids: ["c-1"],
    })
  })
})

describe("companyService.resolveStopTagName", () => {
  beforeEach(() => vi.clearAllMocks())

  test("falls back to the default when unset or blank", async () => {
    mockWorkspaceFind.mockResolvedValue({ id: WS, companyStopTagName: null })
    await expect(
      companyService.resolveStopTagName({ workspaceId: WS }),
    ).resolves.toBe("company-stop")
    mockWorkspaceFind.mockResolvedValue({ id: WS, companyStopTagName: "   " })
    await expect(
      companyService.resolveStopTagName({ workspaceId: WS }),
    ).resolves.toBe("company-stop")
  })

  test("uses the configured name", async () => {
    mockWorkspaceFind.mockResolvedValue({
      id: WS,
      companyStopTagName: " halt-all ",
    })
    await expect(
      companyService.resolveStopTagName({ workspaceId: WS }),
    ).resolves.toBe("halt-all")
  })
})

describe("companyService.assignContact", () => {
  beforeEach(() => vi.clearAllMocks())

  test("unknown contact -> notFound", async () => {
    mockFindOrFail.mockResolvedValue({ id: "company-1" })
    mockSelectLimit.mockResolvedValue([])
    mockUpdateReturning.mockResolvedValue([])
    await expect(
      companyService.assignContact({
        workspaceId: WS,
        contactId: "c-x",
        companyId: "company-1",
      }),
    ).rejects.toMatchObject({ code: "notFound" })
  })

  test("a re-link logs contactUnlinked on the old company and contactLinked on the new", async () => {
    const { companyActivityService } = await import("../src/company/activity")
    const record = vi
      .spyOn(companyActivityService, "record")
      .mockResolvedValue({} as never)
    mockFindOrFail.mockResolvedValue({ id: "company-2" })
    mockSelectLimit.mockResolvedValue([{ id: "c-1", companyId: "company-1" }])
    mockUpdateReturning.mockResolvedValue([{ id: "c-1" }])
    await companyService.assignContact({
      workspaceId: WS,
      contactId: "c-1",
      companyId: "company-2",
      actorId: "u-1",
    })
    expect(record.mock.calls.map((c) => [c[0].companyId, c[0].type])).toEqual([
      ["company-1", "contactUnlinked"],
      ["company-2", "contactLinked"],
    ])
    record.mockClear()
    // same company again: nothing written, nothing logged
    mockSelectLimit.mockResolvedValue([{ id: "c-1", companyId: "company-2" }])
    await companyService.assignContact({
      workspaceId: WS,
      contactId: "c-1",
      companyId: "company-2",
    })
    expect(record).not.toHaveBeenCalled()
    expect(mockInvalidate).toHaveBeenCalledTimes(1)
    record.mockRestore()
  })

  test("a stale expectedCompanyId or a lost UPDATE race is a 409-class validation error, nothing logged", async () => {
    const { companyActivityService } = await import("../src/company/activity")
    const record = vi
      .spyOn(companyActivityService, "record")
      .mockResolvedValue({} as never)
    mockSelectLimit.mockResolvedValue([{ id: "c-1", companyId: "company-9" }])
    await expect(
      companyService.assignContact({
        workspaceId: WS,
        contactId: "c-1",
        companyId: null,
        expectedCompanyId: "company-1",
      }),
    ).rejects.toMatchObject({ code: "validation" })
    mockSelectLimit.mockResolvedValue([{ id: "c-1", companyId: "company-1" }])
    mockUpdateReturning.mockResolvedValue([])
    await expect(
      companyService.assignContact({
        workspaceId: WS,
        contactId: "c-1",
        companyId: null,
        expectedCompanyId: "company-1",
      }),
    ).rejects.toMatchObject({ code: "validation" })
    expect(record).not.toHaveBeenCalled()
    record.mockRestore()
  })

  test("null clears the company without a company lookup", async () => {
    mockSelectLimit.mockResolvedValue([{ id: "c-1", companyId: "company-1" }])
    mockUpdateReturning.mockResolvedValue([{ id: "c-1" }])
    await companyService.assignContact({
      workspaceId: WS,
      contactId: "c-1",
      companyId: null,
    })
    expect(mockFindOrFail).not.toHaveBeenCalled()
    expect(mockInvalidate).toHaveBeenCalledWith({
      workspaceId: WS,
      ids: ["c-1"],
    })
  })
})
