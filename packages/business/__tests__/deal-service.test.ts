import { beforeEach, describe, expect, test, vi } from "vitest"

/**
 * dealService with the database mocked at the query-builder seam. What is
 * pinned: the tx -> emit -> company-stop ORDER, that a no-change write emits
 * nothing, the foreign-stage guard, the reopen-first rule, and the
 * stopCompanyOn matrix.
 */

const m = vi.hoisted(() => {
  const state = {
    deal: null as Record<string, unknown> | null,
    pipeline: null as Record<string, unknown> | null,
    stage: null as Record<string, unknown> | null,
    firstStage: null as Record<string, unknown> | null,
    contact: null as Record<string, unknown> | null,
    member: null as Record<string, unknown> | null,
    updateReturning: [] as Record<string, unknown>[],
    activities: [] as Record<string, unknown>[],
    inserted: [] as Record<string, unknown>[],
  }
  const calls: string[] = []
  const makeTx = () => {
    const selectChain: Record<string, unknown> = {}
    selectChain.from = () => selectChain
    selectChain.where = () => selectChain
    selectChain.innerJoin = () => selectChain
    selectChain.orderBy = () => Promise.resolve([])
    // the max() aggregate is awaited without .limit()
    // biome-ignore lint/suspicious/noThenProperty: awaited query-builder stub
    selectChain.then = (resolve: (v: unknown) => unknown) =>
      resolve([{ maxPosition: 1000 }])
    // contact / member / max() lookups all come through select().limit()
    selectChain.limit = () => {
      const pending = state.contact ?? state.member
      return Promise.resolve(pending ? [pending] : [])
    }
    const insertChain = {
      values: (v: Record<string, unknown>) => {
        state.inserted.push(v)
        if (v.type) {
          state.activities.push(v)
          calls.push(`activity:${v.type}`)
          return { returning: () => Promise.resolve([{ id: "act", ...v }]) }
        }
        calls.push("insert:deal")
        return {
          returning: () =>
            Promise.resolve([
              { ...v, createdAt: new Date(), updatedAt: new Date() },
            ]),
        }
      },
    }
    const updateChain = {
      set: (v: Record<string, unknown>) => {
        calls.push(`update:${Object.keys(v).join(",")}`)
        return updateChain
      },
      where: () => updateChain,
      returning: () =>
        Promise.resolve(
          state.updateReturning.length > 0
            ? state.updateReturning
            : [{ ...(state.deal ?? {}) }],
        ),
    }
    return {
      select: () => selectChain,
      insert: () => insertChain,
      update: () => updateChain,
      transaction: (cb: (tx: unknown) => unknown) => cb(makeTx()),
      query: {
        dealModel: {
          findFirst: vi.fn(async () => undefined),
          findMany: vi.fn(async () => []),
        },
      },
      $count: vi.fn(async () => 0),
    }
  }
  return {
    state,
    calls,
    makeTx,
    findOrFail: vi.fn(),
    pipelineFindOrFail: vi.fn(),
    resolveStage: vi.fn(),
    firstStage: vi.fn(),
    pipelineFind: vi.fn(),
    emitCreated: vi.fn(() => {
      calls.push("emit:created")
      return Promise.resolve()
    }),
    emitMoved: vi.fn(() => {
      calls.push("emit:moved")
      return Promise.resolve()
    }),
    emitValue: vi.fn(() => {
      calls.push("emit:value")
      return Promise.resolve()
    }),
    emitStatus: vi.fn(() => {
      calls.push("emit:status")
      return Promise.resolve()
    }),
    emitPriority: vi.fn(() => {
      calls.push("emit:priority")
      return Promise.resolve()
    }),
    stopCompany: vi.fn(() => {
      calls.push("stop:company")
      return Promise.resolve({ status: "stopped" })
    }),
    loggerWarn: vi.fn(),
  }
})

vi.mock("@chatbotx.io/database/client", () => {
  const dbRoot = m.makeTx()
  return {
    db: dbRoot,
    and: vi.fn((...c: unknown[]) => ({ c })),
    eq: vi.fn((f: unknown, v: unknown) => ({ f, v })),
    desc: vi.fn((f: unknown) => f),
    inArray: vi.fn((f: unknown, v: unknown) => ({ f, v })),
    sql: Object.assign(
      vi.fn((s: TemplateStringsArray, ...v: unknown[]) => ({ s, v })),
      {},
    ),
    findOrFail: (...args: unknown[]) => m.findOrFail(...args),
    relationsFilterToSQL: vi.fn(() => ({})),
  }
})
vi.mock("@chatbotx.io/database/utils", () => ({
  likeContains: (v: string) => `%${v}%`,
  parseOrderByAsObject: () => ({}),
  parsePagination: () => ({ limit: 20, offset: 0 }),
}))
vi.mock("@chatbotx.io/utils", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createId: () => "new-id",
}))
vi.mock("@chatbotx.io/events", () => ({
  emitDealCreated: (...a: unknown[]) => m.emitCreated(...a),
  emitDealMovedToStage: (...a: unknown[]) => m.emitMoved(...a),
  emitDealValueChanged: (...a: unknown[]) => m.emitValue(...a),
  emitDealStatusChanged: (...a: unknown[]) => m.emitStatus(...a),
  emitDealPriorityChanged: (...a: unknown[]) => m.emitPriority(...a),
}))
vi.mock("../src/company/stop", () => ({
  stopCompany: (...a: unknown[]) => m.stopCompany(...a),
}))
vi.mock("../src/pipeline/service", () => ({
  pipelineService: {
    findOrFail: (...a: unknown[]) => m.pipelineFindOrFail(...a),
    resolveStage: (...a: unknown[]) => m.resolveStage(...a),
    firstStage: (...a: unknown[]) => m.firstStage(...a),
    find: (...a: unknown[]) => m.pipelineFind(...a),
  },
}))
vi.mock("../src/audit/dispatcher", () => ({
  dispatchAuditRecord: vi.fn(),
}))
vi.mock("../src/logger", () => ({
  logger: { warn: m.loggerWarn, info: vi.fn() },
}))

const { dealService } = await import("../src/deal/service")

const WS = "ws-1"
const PIPE = (stopCompanyOn: "none" | "created" | "won") => ({
  id: "pipe-1",
  workspaceId: WS,
  settings: { stopCompanyOn, defaultCurrency: "USD" },
})
const STAGE_NEW = {
  id: "stage-new",
  pipelineId: "pipe-1",
  isWon: false,
  isLost: false,
}
const STAGE_WON = {
  id: "stage-won",
  pipelineId: "pipe-1",
  isWon: true,
  isLost: false,
}
const OPEN_DEAL = {
  id: "deal-1",
  workspaceId: WS,
  pipelineId: "pipe-1",
  stageId: "stage-new",
  title: "Roof",
  value: "100.00",
  currency: "USD",
  status: "open",
  priority: "medium",
  position: 1000,
  contactId: "contact-1",
  companyId: "co-1",
  ownerId: null,
  fields: {},
}

beforeEach(() => {
  vi.clearAllMocks()
  m.calls.length = 0
  m.state.inserted.length = 0
  m.state.activities.length = 0
  m.state.updateReturning = []
  m.state.contact = null
  m.state.member = null
  m.state.deal = { ...OPEN_DEAL }
  m.findOrFail.mockImplementation(async () => ({ ...OPEN_DEAL }))
  m.pipelineFindOrFail.mockResolvedValue(PIPE("created"))
  m.resolveStage.mockResolvedValue(STAGE_NEW)
  m.firstStage.mockResolvedValue(STAGE_NEW)
})

describe("dealService.create", () => {
  test("inserts deal + created activity, then emits, then stops the company (stopCompanyOn=created)", async () => {
    m.state.contact = { id: "contact-1", companyId: "co-1" }
    const deal = await dealService.create({
      workspaceId: WS,
      data: {
        title: " Roof ",
        pipelineId: "pipe-1",
        contactId: "contact-1",
        value: "100",
      },
    })
    expect(deal.title).toBe("Roof")
    expect(deal.value).toBe("100.00")
    expect(deal.currency).toBe("USD")
    expect(deal.companyId).toBe("co-1")
    expect(deal.fields).toEqual({})
    expect(m.calls).toEqual([
      "insert:deal",
      "activity:created",
      "emit:created",
      "stop:company",
    ])
    expect(m.stopCompany).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: "co-1", reason: "deal" }),
    )
  })

  test.each([
    ["none", 0],
    ["won", 0],
    ["created", 1],
  ] as const)("stopCompanyOn=%s stops %i time(s) on create", async (mode, times) => {
    m.pipelineFindOrFail.mockResolvedValue(PIPE(mode))
    m.state.contact = { id: "contact-1", companyId: "co-1" }
    await dealService.create({
      workspaceId: WS,
      data: { title: "Roof", pipelineId: "pipe-1", contactId: "contact-1" },
    })
    expect(m.stopCompany).toHaveBeenCalledTimes(times)
  })

  test("no contact = no event and no company stop, but the row is written", async () => {
    const deal = await dealService.create({
      workspaceId: WS,
      data: { title: "Roof", pipelineId: "pipe-1" },
    })
    expect(deal.contactId).toBeNull()
    expect(m.emitCreated).not.toHaveBeenCalled()
    expect(m.stopCompany).not.toHaveBeenCalled()
    expect(m.calls).toEqual(["insert:deal", "activity:created"])
  })

  test("a company-stop failure is logged, never thrown", async () => {
    m.state.contact = { id: "contact-1", companyId: "co-1" }
    m.stopCompany.mockRejectedValueOnce(new Error("scheduler down"))
    await expect(
      dealService.create({
        workspaceId: WS,
        data: { title: "Roof", pipelineId: "pipe-1", contactId: "contact-1" },
      }),
    ).resolves.toMatchObject({ title: "Roof" })
    expect(m.loggerWarn).toHaveBeenCalled()
  })

  test.each([
    [{ title: "" }, "empty title"],
    [{ title: "x", value: "abc" }, "non-numeric value"],
    [{ title: "x", value: -1 }, "negative value"],
    [{ title: "x", currency: "EURO" }, "4-letter currency"],
    [{ title: "x", priority: "urgent" }, "unknown priority"],
  ])("rejects %j (%s)", async (data) => {
    await expect(
      dealService.create({
        workspaceId: WS,
        data: { pipelineId: "pipe-1", ...(data as object) } as never,
      }),
    ).rejects.toThrow()
    expect(m.state.inserted).toHaveLength(0)
  })

  test("a stage outside the pipeline is refused by resolveStage before any write", async () => {
    m.resolveStage.mockRejectedValueOnce(
      new Error("Stage is not in this pipeline."),
    )
    await expect(
      dealService.create({
        workspaceId: WS,
        data: { title: "Roof", pipelineId: "pipe-1", stageId: "stage-other" },
      }),
    ).rejects.toThrow("Stage is not in this pipeline.")
    expect(m.state.inserted).toHaveLength(0)
  })

  test("an owner outside the workspace is refused", async () => {
    m.state.member = null
    await expect(
      dealService.create({
        workspaceId: WS,
        data: { title: "Roof", pipelineId: "pipe-1", ownerId: "user-9" },
      }),
    ).rejects.toThrow("Owner is not a member")
  })
})

describe("dealService.update", () => {
  test("value 100 -> '100.00' is no change: no activity, no emit", async () => {
    const deal = await dealService.update({
      workspaceId: WS,
      id: "deal-1",
      data: { value: 100 },
    })
    expect(deal.value).toBe("100.00")
    expect(m.calls).toEqual([])
    expect(m.emitValue).not.toHaveBeenCalled()
  })

  test("a real value change = one activity + one valueChanged emit with the old value", async () => {
    m.state.updateReturning = [{ ...OPEN_DEAL, value: "250.00" }]
    await dealService.update({
      workspaceId: WS,
      id: "deal-1",
      data: { value: "250" },
    })
    expect(m.calls).toEqual([
      "update:value",
      "activity:valueChanged",
      "emit:value",
    ])
    expect(m.emitValue).toHaveBeenCalledWith(
      WS,
      "contact-1",
      expect.objectContaining({
        oldValue: "100.00",
        value: "250.00",
      }),
    )
  })

  test("priority change emits priorityChanged; same priority emits nothing", async () => {
    m.state.updateReturning = [{ ...OPEN_DEAL, priority: "high" }]
    await dealService.update({
      workspaceId: WS,
      id: "deal-1",
      data: { priority: "high" },
    })
    expect(m.emitPriority).toHaveBeenCalledTimes(1)
    m.calls.length = 0
    await dealService.update({
      workspaceId: WS,
      id: "deal-1",
      data: { priority: "medium" },
    })
    expect(m.calls).toEqual([])
  })
})

describe("dealService.moveStage", () => {
  test("same stage = reposition only, no activity, no event", async () => {
    await dealService.moveStage({
      workspaceId: WS,
      id: "deal-1",
      stageId: "stage-new",
      position: 500,
    })
    expect(m.calls).toEqual(["update:position"])
    expect(m.emitMoved).not.toHaveBeenCalled()
  })

  test("moving onto the won stage emits moved then delegates to setStatus(won)", async () => {
    m.resolveStage.mockResolvedValue(STAGE_WON)
    m.pipelineFindOrFail.mockResolvedValue(PIPE("won"))
    m.state.updateReturning = [{ ...OPEN_DEAL, stageId: "stage-won" }]
    await dealService.moveStage({
      workspaceId: WS,
      id: "deal-1",
      stageId: "stage-won",
    })
    expect(m.calls.slice(0, 3)).toEqual([
      "update:stageId,position",
      "activity:stageMoved",
      "emit:moved",
    ])
    expect(m.calls).toContain("activity:statusChanged")
    expect(m.calls).toContain("emit:status")
    expect(m.calls.at(-1)).toBe("stop:company")
    expect(m.emitMoved).toHaveBeenCalledWith(
      WS,
      "contact-1",
      expect.objectContaining({
        fromStageId: "stage-new",
        stageId: "stage-won",
      }),
    )
  })

  test("a stage of another pipeline is refused", async () => {
    m.resolveStage.mockRejectedValueOnce(
      new Error("Stage is not in this pipeline."),
    )
    await expect(
      dealService.moveStage({
        workspaceId: WS,
        id: "deal-1",
        stageId: "foreign",
      }),
    ).rejects.toThrow("Stage is not in this pipeline.")
    expect(m.calls).toEqual([])
  })

  test("a non-finite position is refused", async () => {
    await expect(
      dealService.moveStage({
        workspaceId: WS,
        id: "deal-1",
        stageId: "stage-new",
        position: Number.NaN,
      }),
    ).rejects.toThrow("Position")
  })
})

describe("dealService.setStatus", () => {
  test("same status is idempotent: no activity, no emit", async () => {
    await dealService.setStatus({
      workspaceId: WS,
      id: "deal-1",
      status: "open",
    })
    expect(m.calls).toEqual([])
    expect(m.emitStatus).not.toHaveBeenCalled()
  })

  test.each([
    ["none", 0],
    ["created", 0],
    ["won", 1],
  ] as const)("won with stopCompanyOn=%s stops the company %i time(s)", async (mode, times) => {
    m.pipelineFindOrFail.mockResolvedValue(PIPE(mode))
    m.state.updateReturning = [{ ...OPEN_DEAL, status: "won" }]
    await dealService.setStatus({
      workspaceId: WS,
      id: "deal-1",
      status: "won",
    })
    expect(m.calls.slice(0, 3)).toEqual([
      "update:status,closedAt",
      "activity:statusChanged",
      "emit:status",
    ])
    expect(m.stopCompany).toHaveBeenCalledTimes(times)
  })

  test("lost never stops the company even with stopCompanyOn=won", async () => {
    m.pipelineFindOrFail.mockResolvedValue(PIPE("won"))
    m.state.updateReturning = [{ ...OPEN_DEAL, status: "lost" }]
    await dealService.setStatus({
      workspaceId: WS,
      id: "deal-1",
      status: "lost",
    })
    expect(m.stopCompany).not.toHaveBeenCalled()
  })

  test("won -> lost is refused: reopen first", async () => {
    m.findOrFail.mockImplementation(async () => ({
      ...OPEN_DEAL,
      status: "won",
    }))
    await expect(
      dealService.setStatus({ workspaceId: WS, id: "deal-1", status: "lost" }),
    ).rejects.toThrow("reopen")
    expect(m.calls).toEqual([])
  })

  test("an unknown status is refused before any read", async () => {
    await expect(
      dealService.setStatus({
        workspaceId: WS,
        id: "deal-1",
        status: "closed" as never,
      }),
    ).rejects.toThrow("Status is open, won or lost.")
    expect(m.findOrFail).not.toHaveBeenCalled()
  })
})

describe("dealService.addNote", () => {
  test.each([
    ["", "empty"],
    ["   ", "blank"],
    ["x".repeat(4001), "too long"],
  ])("rejects %j (%s)", async (text) => {
    await expect(
      dealService.addNote({ workspaceId: WS, id: "deal-1", text }),
    ).rejects.toThrow()
  })
})

describe("dealService.positionBetween", () => {
  test.each([
    [null, null, 1000],
    [null, 1000, 0],
    [1000, null, 2000],
    [1000, 2000, 1500],
  ])("between %s and %s -> %s", (before, after, expected) => {
    expect(dealService.positionBetween(before, after)).toBe(expected)
  })
})
