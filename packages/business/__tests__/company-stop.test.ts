import { beforeEach, describe, expect, test, vi } from "vitest"

const {
  mockTransaction,
  mockTxSelectFor,
  mockTxUpdateWhere,
  mockDbSelectLimit,
  mockListContactIds,
  mockListByContactId,
  mockRemoveSequences,
  mockCancelActiveForContacts,
  mockHasActiveForContacts,
  mockQueueRemove,
  mockMarkBroadcastFailed,
  mockEnsureTag,
  mockBulkAttach,
  mockLoggerWarn,
  mockAudit,
} = vi.hoisted(() => {
  const txSelectFor = vi.fn()
  const txSelectChain = {
    from: vi.fn(),
    where: vi.fn(),
    for: txSelectFor,
  }
  txSelectChain.from.mockReturnValue(txSelectChain)
  txSelectChain.where.mockReturnValue(txSelectChain)
  const txUpdateWhere = vi.fn().mockResolvedValue(undefined)
  const txUpdateChain = { set: vi.fn(), where: txUpdateWhere }
  txUpdateChain.set.mockReturnValue(txUpdateChain)
  const tx = {
    select: vi.fn(() => txSelectChain),
    update: vi.fn(() => txUpdateChain),
  }
  const dbSelectLimit = vi.fn()
  const dbSelectChain = { from: vi.fn(), where: vi.fn(), limit: dbSelectLimit }
  dbSelectChain.from.mockReturnValue(dbSelectChain)
  dbSelectChain.where.mockReturnValue(dbSelectChain)
  return {
    mockTransaction: vi.fn((callback: (client: unknown) => unknown) =>
      callback(tx),
    ),
    mockTxSelectFor: txSelectFor,
    mockTxUpdateWhere: txUpdateWhere,
    mockDbSelectChain: dbSelectChain,
    mockDbSelectLimit: dbSelectLimit,
    mockDbSelect: vi.fn(() => dbSelectChain),
    mockListContactIds: vi.fn(),
    mockListByContactId: vi.fn(),
    mockRemoveSequences: vi.fn(),
    mockCancelActiveForContacts: vi.fn(),
    mockHasActiveForContacts: vi.fn(async () => false),
    mockQueueRemove: vi.fn(),
    mockMarkBroadcastFailed: vi.fn(),
    mockEnsureTag: vi.fn(),
    mockBulkAttach: vi.fn(),
    mockLoggerWarn: vi.fn(),
    mockAudit: vi.fn(),
  }
})

vi.mock("@chatbotx.io/database/client", () => ({
  db: {
    transaction: mockTransaction,
    select: () => {
      const chain = {
        from: () => chain,
        where: () => chain,
        limit: mockDbSelectLimit,
      }
      return chain
    },
  },
  and: vi.fn((...conditions: unknown[]) => ({ conditions })),
  eq: vi.fn((field: unknown, value: unknown) => ({ field, value })),
}))
vi.mock("@chatbotx.io/worker-config", () => ({
  integrationQueue: { remove: mockQueueRemove },
}))
vi.mock("@chatbotx.io/flow-config", () => ({
  buildJobId: (id: string, at: Date) => `${id}:${at.toISOString()}`,
}))
vi.mock("../src/audit/dispatcher", () => ({
  dispatchAuditRecordSafely: mockAudit,
}))
vi.mock("../src/logger", () => ({
  logger: { warn: mockLoggerWarn, info: vi.fn(), error: vi.fn() },
}))
vi.mock("../src/company/service", () => ({
  companyService: { listContactIds: mockListContactIds },
}))
vi.mock("../src/company/activity", () => ({
  companyActivityService: { record: vi.fn(async () => ({})) },
}))
vi.mock("../src/contact-sequence/service", () => ({
  contactSequenceService: {
    listByContactId: mockListByContactId,
    removeContactSequencesForContacts: mockRemoveSequences,
  },
}))
vi.mock("../src/smart-delay/service", () => ({
  smartDelayService: {
    cancelActiveForContacts: mockCancelActiveForContacts,
    hasActiveForContacts: mockHasActiveForContacts,
  },
}))
vi.mock("../src/broadcast/service", () => ({
  broadcastService: { markContactsFailedForContacts: mockMarkBroadcastFailed },
}))
vi.mock("../src/tag/service", () => ({
  tagService: {
    ensureTagByName: mockEnsureTag,
    bulkAttachToContacts: mockBulkAttach,
  },
}))

const { stopCompany, stopCompanyForContact } = await import(
  "../src/company/stop"
)

const WS = "ws-1"
const COMPANY = "company-1"

function companyRow(
  overrides: Partial<{ stoppedAt: Date | null; stopOnReply: boolean }> = {},
) {
  return { id: COMPANY, stoppedAt: null, stopOnReply: true, ...overrides }
}

describe("stopCompany", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockTxSelectFor.mockResolvedValue([companyRow()])
    mockListContactIds.mockResolvedValue(["c-1", "c-2"])
    mockListByContactId.mockImplementation(async ({ contactId }) =>
      contactId === "c-1"
        ? [{ sequenceId: "s-1", sequenceName: "A" }]
        : [{ sequenceId: "s-2", sequenceName: "B" }],
    )
    mockRemoveSequences.mockResolvedValue([{ id: "d1" }, { id: "d2" }])
    mockCancelActiveForContacts.mockResolvedValue([])
    mockHasActiveForContacts.mockResolvedValue(false)
    mockQueueRemove.mockResolvedValue(undefined)
    mockMarkBroadcastFailed.mockResolvedValue(1)
    mockEnsureTag.mockResolvedValue("tag-stopped")
    mockBulkAttach.mockResolvedValue({ attachedPairCount: 2 })
    mockAudit.mockResolvedValue(undefined)
  })

  test("stops: stamps the row and runs all four phases for every contact", async () => {
    mockCancelActiveForContacts
      .mockResolvedValueOnce([
        { id: "sd-1", triggerAt: new Date("2026-09-23T00:00:00Z") },
      ])
      .mockResolvedValueOnce([])

    const result = await stopCompany({
      workspaceId: WS,
      companyId: COMPANY,
      reason: "contact_replied",
      triggeredByContactId: "c-1",
    })

    expect(result).toEqual({
      status: "stopped",
      companyId: COMPANY,
      contactCount: 2,
      enrollmentsRemoved: 2,
      smartDelaysCanceled: 1,
      broadcastRowsFailed: 1,
      tagId: "tag-stopped",
      failedPhases: [],
    })
    expect(mockTxUpdateWhere).toHaveBeenCalledTimes(1)
    expect(mockRemoveSequences).toHaveBeenCalledWith({
      workspaceId: WS,
      contactIds: ["c-1", "c-2"],
      sequenceIds: ["s-1", "s-2"],
      reason: "company_stopped",
    })
    expect(mockCancelActiveForContacts).toHaveBeenCalledWith({
      workspaceId: WS,
      contactIds: ["c-1", "c-2"],
      limit: 500,
    })
    expect(mockQueueRemove).toHaveBeenCalledWith(
      "sd-1:2026-09-23T00:00:00.000Z",
    )
    expect(mockMarkBroadcastFailed).toHaveBeenCalledWith({
      workspaceId: WS,
      contactIds: ["c-1", "c-2"],
      reason: "company-stopped",
    })
    expect(mockEnsureTag).toHaveBeenCalledWith({
      workspaceId: WS,
      name: "company-stopped",
    })
    expect(mockBulkAttach).toHaveBeenCalledWith({
      workspaceId: WS,
      contactIds: ["c-1", "c-2"],
      tagIds: ["tag-stopped"],
    })
    expect(mockAudit).toHaveBeenCalledTimes(1)
  })

  test("already stopped: no-op, nothing else touched", async () => {
    mockTxSelectFor.mockResolvedValue([companyRow({ stoppedAt: new Date() })])
    const result = await stopCompany({
      workspaceId: WS,
      companyId: COMPANY,
      reason: "api",
    })
    expect(result).toEqual({ status: "already_stopped", companyId: COMPANY })
    expect(mockTxUpdateWhere).not.toHaveBeenCalled()
    expect(mockListContactIds).not.toHaveBeenCalled()
    expect(mockBulkAttach).not.toHaveBeenCalled()
  })

  test("already stopped + force: re-runs the cascade", async () => {
    mockTxSelectFor.mockResolvedValue([companyRow({ stoppedAt: new Date() })])
    const result = await stopCompany({
      workspaceId: WS,
      companyId: COMPANY,
      reason: "api",
      force: true,
    })
    expect(result.status).toBe("stopped")
    expect(mockBulkAttach).toHaveBeenCalledTimes(1)
  })

  test("stopOnReply off: a reply or the tag is skipped, the API and a deal still stop", async () => {
    mockTxSelectFor.mockResolvedValue([companyRow({ stopOnReply: false })])
    await expect(
      stopCompany({
        workspaceId: WS,
        companyId: COMPANY,
        reason: "contact_replied",
      }),
    ).resolves.toEqual({
      status: "skipped",
      companyId: COMPANY,
      why: "stopOnReply_off",
    })
    await expect(
      stopCompany({
        workspaceId: WS,
        companyId: COMPANY,
        reason: "tag_applied",
      }),
    ).resolves.toMatchObject({ status: "skipped" })
    expect(mockTxUpdateWhere).not.toHaveBeenCalled()
    await expect(
      stopCompany({ workspaceId: WS, companyId: COMPANY, reason: "api" }),
    ).resolves.toMatchObject({ status: "stopped" })
    await expect(
      stopCompany({ workspaceId: WS, companyId: COMPANY, reason: "deal" }),
    ).resolves.toMatchObject({ status: "stopped" })
  })

  test("two racing stops: the row lock hands the cascade to exactly one", async () => {
    // The first transaction sees an unstopped row and stamps it; the second,
    // serialised behind the lock, reads the stamped row.
    mockTxSelectFor
      .mockResolvedValueOnce([companyRow()])
      .mockResolvedValueOnce([companyRow({ stoppedAt: new Date() })])
    const [a, b] = await Promise.all([
      stopCompany({
        workspaceId: WS,
        companyId: COMPANY,
        reason: "contact_replied",
      }),
      stopCompany({
        workspaceId: WS,
        companyId: COMPANY,
        reason: "tag_applied",
      }),
    ])
    const statuses = [a.status, b.status].sort()
    expect(statuses).toEqual(["already_stopped", "stopped"])
    expect(mockBulkAttach).toHaveBeenCalledTimes(1)
  })

  test("a failing phase is logged, the remaining phases still run, and the result is partial", async () => {
    mockRemoveSequences.mockRejectedValue(new Error("sequence boom"))
    mockQueueRemove.mockRejectedValue(new Error("redis down"))
    mockCancelActiveForContacts
      .mockResolvedValueOnce([{ id: "sd-1", triggerAt: new Date(0) }])
      .mockResolvedValueOnce([])
    const result = await stopCompany({
      workspaceId: WS,
      companyId: COMPANY,
      reason: "api",
    })
    expect(result).toMatchObject({
      status: "partial",
      enrollmentsRemoved: 0,
      smartDelaysCanceled: 1,
      broadcastRowsFailed: 1,
      tagId: "tag-stopped",
      failedPhases: ["sequences"],
    })
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "sequences" }),
      "company-stop: cascade phase failed",
    )
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ failedCount: 1 }),
      "company-stop: failed to remove smart-delay jobs",
    )
  })

  test("rows still firable after the cancel's retries make the stop partial, never stopped", async () => {
    mockCancelActiveForContacts.mockResolvedValueOnce([
      { id: "sd-1", triggerAt: new Date(0) },
    ])
    mockHasActiveForContacts.mockResolvedValue(true)
    const result = await stopCompany({
      workspaceId: WS,
      companyId: COMPANY,
      reason: "api",
    })
    expect(result).toMatchObject({
      status: "partial",
      failedPhases: ["smart-delays"],
      smartDelaysCanceled: 1,
      tagId: "tag-stopped",
    })
  })

  test("a company with no contacts stops with zero counts and no tag attach", async () => {
    mockListContactIds.mockResolvedValue([])
    mockBulkAttach.mockResolvedValue({ attachedPairCount: 0 })
    const result = await stopCompany({
      workspaceId: WS,
      companyId: COMPANY,
      reason: "api",
    })
    expect(result).toMatchObject({
      status: "stopped",
      contactCount: 0,
      enrollmentsRemoved: 0,
    })
    expect(mockRemoveSequences).not.toHaveBeenCalled()
  })

  test("a failing tag phase is partial with the tag named (the signal flows depend on)", async () => {
    mockEnsureTag.mockRejectedValue(new Error("tag boom"))
    const result = await stopCompany({
      workspaceId: WS,
      companyId: COMPANY,
      reason: "api",
    })
    expect(result).toMatchObject({
      status: "partial",
      failedPhases: ["tag"],
      tagId: undefined,
    })
  })

  test("unknown company rejects with a typed notFound", async () => {
    mockTxSelectFor.mockResolvedValue([])
    await expect(
      stopCompany({ workspaceId: WS, companyId: "nope", reason: "api" }),
    ).rejects.toMatchObject({ code: "notFound", httpStatusCode: 404 })
  })

  test("two concurrent force re-runs both complete (every phase is idempotent)", async () => {
    mockTxSelectFor.mockResolvedValue([companyRow({ stoppedAt: new Date() })])
    const [a, b] = await Promise.all([
      stopCompany({
        workspaceId: WS,
        companyId: COMPANY,
        reason: "api",
        force: true,
      }),
      stopCompany({
        workspaceId: WS,
        companyId: COMPANY,
        reason: "api",
        force: true,
      }),
    ])
    expect(a.status).toBe("stopped")
    expect(b.status).toBe("stopped")
    expect(mockBulkAttach).toHaveBeenCalledTimes(2)
    expect(mockTxUpdateWhere).not.toHaveBeenCalled()
  })
})

describe("stopCompanyForContact", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockTxSelectFor.mockResolvedValue([companyRow()])
    mockListContactIds.mockResolvedValue(["c-1"])
    mockListByContactId.mockResolvedValue([])
    mockCancelActiveForContacts.mockResolvedValue([])
    mockMarkBroadcastFailed.mockResolvedValue(0)
    mockEnsureTag.mockResolvedValue("tag-stopped")
    mockBulkAttach.mockResolvedValue({ attachedPairCount: 1 })
    mockAudit.mockResolvedValue(undefined)
  })

  test("contact without a company -> no_company, nothing stopped", async () => {
    mockDbSelectLimit.mockResolvedValue([{ companyId: null }])
    await expect(
      stopCompanyForContact({
        workspaceId: WS,
        contactId: "c-9",
        reason: "contact_replied",
      }),
    ).resolves.toEqual({ status: "no_company", contactId: "c-9" })
    expect(mockTransaction).not.toHaveBeenCalled()
  })

  test("unknown contact -> no_company", async () => {
    mockDbSelectLimit.mockResolvedValue([])
    await expect(
      stopCompanyForContact({
        workspaceId: WS,
        contactId: "c-9",
        reason: "contact_replied",
      }),
    ).resolves.toEqual({ status: "no_company", contactId: "c-9" })
  })

  test("contact with a company -> stopped, with the contact as the trigger", async () => {
    mockDbSelectLimit.mockResolvedValue([{ companyId: COMPANY }])
    await expect(
      stopCompanyForContact({
        workspaceId: WS,
        contactId: "c-1",
        reason: "contact_replied",
      }),
    ).resolves.toMatchObject({
      status: "stopped",
      companyId: COMPANY,
      contactCount: 1,
    })
    expect(mockTransaction).toHaveBeenCalledTimes(1)
  })
})
