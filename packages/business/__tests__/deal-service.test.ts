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
    executeArgs: [] as unknown[][],
    openDeal: null as Record<string, unknown> | null,
    updateEmpty: false,
    lastListWhere: null as unknown,
    rowLocks: [] as string[],
    /** s198 board: findMany rows, then one groupBy result per count query */
    boardDeals: [] as Record<string, unknown>[],
    groupResults: [] as unknown[][],
    groupByCalls: 0,
  }
  const calls: string[] = []
  const makeTx = () => {
    const selectChain: Record<string, unknown> = {}
    selectChain.from = () => selectChain
    selectChain.where = () => selectChain
    selectChain.innerJoin = () => selectChain
    selectChain.groupBy = () => {
      state.groupByCalls++
      return Promise.resolve(state.groupResults.shift() ?? [])
    }
    selectChain.for = (mode: string) => {
      state.rowLocks.push(mode)
      return selectChain
    }
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
      returning: () => {
        if (state.updateEmpty) {
          return Promise.resolve([])
        }
        return Promise.resolve(
          state.updateReturning.length > 0
            ? state.updateReturning
            : [{ ...(state.deal ?? {}) }],
        )
      },
    }
    return {
      select: () => selectChain,
      insert: () => insertChain,
      update: () => updateChain,
      transaction: (cb: (tx: unknown) => unknown) => cb(makeTx()),
      execute: (...args: unknown[]) => {
        calls.push("advisory-lock")
        state.executeArgs.push(args)
        return Promise.resolve(undefined)
      },
      query: {
        dealModel: {
          findFirst: () => Promise.resolve(state.openDeal ?? undefined),
          findMany: (args: { where?: unknown }) => {
            state.lastListWhere = args?.where ?? null
            return Promise.resolve(state.boardDeals)
          },
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
    visibleIds: vi.fn(async () => null),
    pickRoundRobin: vi.fn(),
    isMember: vi.fn(async () => false),
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
    findMember: vi.fn(),
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
// s195: the company change log rides BESIDE the deal write (recordSafely
// after commit); it is its own service with its own tests.
vi.mock("../src/company/activity", () => ({
  companyActivityService: {
    record: vi.fn(async () => ({})),
    recordSafely: vi.fn(async () => undefined),
  },
}))
vi.mock("../src/company/service", () => ({
  companyService: {
    findOrFail: vi.fn(async (p: { id: string }) => ({ id: p.id })),
  },
}))
vi.mock("../src/pipeline/service", () => ({
  pipelineService: {
    findOrFail: (...a: unknown[]) => m.pipelineFindOrFail(...a),
    resolveStage: (...a: unknown[]) => m.resolveStage(...a),
    firstStage: (...a: unknown[]) => m.firstStage(...a),
    find: (...a: unknown[]) => m.pipelineFind(...a),
    visibleIds: (...a: unknown[]) => m.visibleIds(...a),
  },
}))
vi.mock("../src/pipeline/members", () => ({
  pipelineMemberService: {
    pickRoundRobin: (...a: unknown[]) => m.pickRoundRobin(...a),
    isMember: (...a: unknown[]) => m.isMember(...a),
  },
}))
// s196: movePipeline checks that the owner can still see a members-only target
vi.mock("../src/workspace-member/service", () => ({
  workspaceMemberService: {
    findByWorkspaceIdAndUserId: (...a: unknown[]) => m.findMember(...a),
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
const ROOF_DEFS = [
  {
    key: "roofType",
    label: "Roof type",
    type: "select" as const,
    options: ["metal", "shingle"],
    required: false,
  },
  { key: "sqft", label: "Sq ft", type: "number" as const, required: true },
]
const PIPE = (
  stopCompanyOn: "none" | "created" | "won",
  fieldDefs: typeof ROOF_DEFS | [] = [],
) => ({
  id: "pipe-1",
  workspaceId: WS,
  settings: {
    stopCompanyOn,
    defaultCurrency: "USD",
    fieldDefs,
    assignOwner: "none",
    access: "workspace",
  },
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
  m.state.executeArgs.length = 0
  m.state.rowLocks.length = 0
  m.state.openDeal = null
  m.state.updateEmpty = false
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

describe("dealService.update phase-2 activities (s192)", () => {
  test("title / currency / dueAt each write one activity in the tx and no event", async () => {
    await dealService.update({
      workspaceId: WS,
      id: "deal-1",
      data: {
        title: " Roof v2 ",
        currency: "eur",
        dueAt: new Date("2026-10-01T00:00:00Z"),
      },
    })
    expect(m.state.activities.map((a) => a.type)).toEqual([
      "titleChanged",
      "currencyChanged",
      "dueAtChanged",
    ])
    expect(m.state.activities[0].payload).toEqual({
      from: "Roof",
      to: "Roof v2",
    })
    expect(m.state.activities[1].payload).toEqual({ from: "USD", to: "EUR" })
    expect(m.state.activities[2].payload).toEqual({
      from: null,
      to: "2026-10-01T00:00:00.000Z",
    })
    expect(m.emitValue).not.toHaveBeenCalled()
    expect(m.emitPriority).not.toHaveBeenCalled()
  })

  test("the same title, currency and dueAt write nothing", async () => {
    await dealService.update({
      workspaceId: WS,
      id: "deal-1",
      data: { title: "Roof", currency: "usd", dueAt: null },
    })
    expect(m.state.activities).toEqual([])
    expect(m.calls).not.toContain("update:deal")
  })

  test("an invalid dueAt is a 422", async () => {
    await expect(
      dealService.update({
        workspaceId: WS,
        id: "deal-1",
        data: { dueAt: "not a date" as unknown as Date },
      }),
    ).rejects.toThrow("Due date")
  })

  test("a declared field change writes one fieldChanged activity per key and merges", async () => {
    m.pipelineFindOrFail.mockResolvedValue(PIPE("created", ROOF_DEFS))
    m.findOrFail.mockImplementation(async () => ({
      ...OPEN_DEAL,
      fields: { roofType: "metal", sqft: 100, memo: "x" },
    }))
    await dealService.update({
      workspaceId: WS,
      id: "deal-1",
      data: { fields: { roofType: "shingle", sqft: 100, extra: "free" } },
    })
    expect(m.state.activities.map((a) => a.payload)).toEqual([
      { key: "roofType", from: "metal", to: "shingle" },
      { key: "extra", from: null, to: "free" },
    ])
    expect(m.calls).toContain("update:fields")
  })

  test.each([
    [{ roofType: "tile" }, "must be one of metal, shingle"],
    [{ sqft: "big" }, "finite number"],
    [[1, 2], "must be an object"],
    ["text", "must be an object"],
  ])("fields %j on update -> 422 %s", async (fields, message) => {
    m.pipelineFindOrFail.mockResolvedValue(PIPE("created", ROOF_DEFS))
    await expect(
      dealService.update({
        workspaceId: WS,
        id: "deal-1",
        data: { fields: fields as unknown as Record<string, unknown> },
      }),
    ).rejects.toThrow(message)
    expect(m.state.activities).toEqual([])
  })

  test("create requires the required declared fields and accepts a valid set", async () => {
    m.pipelineFindOrFail.mockResolvedValue(PIPE("none", ROOF_DEFS))
    await expect(
      dealService.create({
        workspaceId: WS,
        data: {
          title: "Roof",
          pipelineId: "pipe-1",
          fields: { roofType: "metal" },
        },
      }),
    ).rejects.toThrow('"sqft" is required')
    expect(m.state.inserted).toEqual([])
    const deal = await dealService.create({
      workspaceId: WS,
      data: {
        title: "Roof",
        pipelineId: "pipe-1",
        fields: { roofType: "metal", sqft: 1200 },
      },
    })
    expect(deal.fields).toEqual({ roofType: "metal", sqft: 1200 })
  })

  test("create rejects a fields blob over the byte cap and over the key cap", async () => {
    const big = { memo: "x".repeat(9000) }
    await expect(
      dealService.create({
        workspaceId: WS,
        data: { title: "Roof", pipelineId: "pipe-1", fields: big },
      }),
    ).rejects.toThrow("exceeds 8192 bytes")
    const many = Object.fromEntries(
      Array.from({ length: 51 }, (_, i) => [`k${i}`, i]),
    )
    await expect(
      dealService.create({
        workspaceId: WS,
        data: { title: "Roof", pipelineId: "pipe-1", fields: many },
      }),
    ).rejects.toThrow("more than 50 keys")
  })
})

describe("dealService.update: stale stored values vs edited fieldDefs (skeptic HIGH, s192)", () => {
  test("a stored select value no longer in the options does NOT block an unrelated field edit", async () => {
    m.pipelineFindOrFail.mockResolvedValue(PIPE("created", ROOF_DEFS))
    m.findOrFail.mockImplementation(async () => ({
      ...OPEN_DEAL,
      fields: { roofType: "tile", sqft: 100 },
    }))
    await dealService.update({
      workspaceId: WS,
      id: "deal-1",
      data: { fields: { sqft: 200 } },
    })
    expect(m.calls).toContain("update:fields")
    expect(m.state.activities.map((a) => a.payload)).toEqual([
      { key: "sqft", from: 100, to: 200 },
    ])
  })

  test("but writing the stale key itself is still type-checked", async () => {
    m.pipelineFindOrFail.mockResolvedValue(PIPE("created", ROOF_DEFS))
    await expect(
      dealService.update({
        workspaceId: WS,
        id: "deal-1",
        data: { fields: { roofType: "tile" } },
      }),
    ).rejects.toThrow("must be one of metal, shingle")
  })
})

describe("dealService.createUnlessOpen (flow step skipIfOpenDealExists)", () => {
  const data = { title: "Roof", pipelineId: "pipe-1", contactId: "contact-1" }

  test("takes the advisory lock BEFORE the open-deal check, then inserts when none exists", async () => {
    m.state.contact = { id: "contact-1", companyId: null }
    const result = await dealService.createUnlessOpen({ workspaceId: WS, data })
    expect(result.created).toBe(true)
    expect(m.calls.slice(0, 3)).toEqual([
      "advisory-lock",
      "insert:deal",
      "activity:created",
    ])
    expect(m.emitCreated).toHaveBeenCalledTimes(1)
  })

  test("returns the existing open deal without inserting or emitting", async () => {
    m.state.openDeal = { ...OPEN_DEAL, id: "deal-existing" }
    const result = await dealService.createUnlessOpen({ workspaceId: WS, data })
    expect(result).toEqual({ created: false, deal: m.state.openDeal })
    expect(m.calls).toEqual(["advisory-lock"])
    expect(m.emitCreated).not.toHaveBeenCalled()
    expect(m.stopCompany).not.toHaveBeenCalled()
  })

  test("still validates input before touching the database", async () => {
    await expect(
      dealService.createUnlessOpen({
        workspaceId: WS,
        data: { ...data, title: "" },
      }),
    ).rejects.toThrow("Title is required.")
    expect(m.calls).toEqual([])
  })
})

describe("dealService.create into a won stage", () => {
  test("stopCompanyOn=won stops the company at create when the landing stage isWon", async () => {
    m.pipelineFindOrFail.mockResolvedValue(PIPE("won"))
    m.resolveStage.mockResolvedValue(STAGE_WON)
    m.state.contact = { id: "contact-1", companyId: "co-1" }
    const deal = await dealService.create({
      workspaceId: WS,
      data: {
        title: "Roof",
        pipelineId: "pipe-1",
        stageId: "stage-won",
        contactId: "contact-1",
      },
    })
    expect(deal.status).toBe("won")
    expect(m.stopCompany).toHaveBeenCalledTimes(1)
  })

  test("stopCompanyOn=won does NOT stop at create when the landing stage is open", async () => {
    m.pipelineFindOrFail.mockResolvedValue(PIPE("won"))
    m.state.contact = { id: "contact-1", companyId: "co-1" }
    await dealService.create({
      workspaceId: WS,
      data: { title: "Roof", pipelineId: "pipe-1", contactId: "contact-1" },
    })
    expect(m.stopCompany).not.toHaveBeenCalled()
  })
})

describe("dealService concurrent-change guards", () => {
  test("moveStage whose UPDATE matches no row (stage changed under us) throws a conflict, records nothing", async () => {
    m.resolveStage.mockResolvedValue(STAGE_WON)
    m.state.updateEmpty = true
    await expect(
      dealService.moveStage({
        workspaceId: WS,
        id: "deal-1",
        stageId: "stage-won",
      }),
    ).rejects.toThrow("changed by someone else")
    expect(m.calls).toEqual(["update:stageId,position"])
    expect(m.emitMoved).not.toHaveBeenCalled()
  })

  test("setStatus whose UPDATE matches no row (status changed under us) throws a conflict", async () => {
    m.state.updateEmpty = true
    await expect(
      dealService.setStatus({ workspaceId: WS, id: "deal-1", status: "won" }),
    ).rejects.toThrow("changed by someone else")
    expect(m.emitStatus).not.toHaveBeenCalled()
  })

  test("update with the same currency writes nothing", async () => {
    await dealService.update({
      workspaceId: WS,
      id: "deal-1",
      data: { currency: "usd" },
    })
    expect(m.calls).toEqual([])
  })
})

describe("stage-entered hook (s192 task templates)", () => {
  test("create and a real move run the registered handler AFTER the event; a failing handler is logged", async () => {
    const { onStageEntered, _resetStageEnteredHandlers } = await import(
      "../src/deal/stage-hooks"
    )
    _resetStageEnteredHandlers()
    const seen: string[] = []
    const off = onStageEntered((ctx) => {
      seen.push(`${ctx.deal.id}:${ctx.stageId}:${ctx.actorId}`)
      m.calls.push("hook:stage")
      return Promise.resolve()
    })
    onStageEntered(() => Promise.reject(new Error("boom")))
    try {
      m.state.contact = { id: "contact-1", companyId: null }
      await dealService.create({
        workspaceId: WS,
        data: { title: "Roof", pipelineId: "pipe-1", contactId: "contact-1" },
        actorId: "actor-1",
      })
      expect(seen).toEqual(["new-id:stage-new:actor-1"])
      expect(m.calls.indexOf("hook:stage")).toBeGreaterThan(
        m.calls.indexOf("emit:created"),
      )
      expect(m.loggerWarn).toHaveBeenCalledTimes(1)

      m.state.updateReturning = [{ ...OPEN_DEAL, stageId: "stage-won" }]
      m.resolveStage.mockResolvedValue(STAGE_WON)
      await dealService.moveStage({
        workspaceId: WS,
        id: "deal-1",
        stageId: "stage-won",
      })
      expect(seen).toHaveLength(2)
      expect(seen[1]).toBe("deal-1:stage-won:null")
    } finally {
      off()
      _resetStageEnteredHandlers()
    }
  })
})

describe("dealService round-robin owner (s193)", () => {
  const RR = {
    ...PIPE("none"),
    settings: { ...PIPE("none").settings, assignOwner: "roundRobin" },
  }

  test("no ownerId + assignOwner=roundRobin picks the next member inside the insert tx", async () => {
    m.pipelineFindOrFail.mockResolvedValue(RR)
    m.pickRoundRobin.mockImplementation(() => {
      m.calls.push("pick")
      return Promise.resolve("user-2")
    })
    const deal = await dealService.create({
      workspaceId: WS,
      data: { title: "Roof", pipelineId: "pipe-1" },
    })
    expect(deal.ownerId).toBe("user-2")
    expect(m.calls.slice(0, 2)).toEqual(["pick", "insert:deal"])
    expect(m.pickRoundRobin).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WS,
        pipelineId: "pipe-1",
        tx: expect.objectContaining({ transaction: expect.any(Function) }),
      }),
    )
  })

  test("an explicit ownerId: null keeps the deal ownerless (no pick)", async () => {
    m.pipelineFindOrFail.mockResolvedValue(RR)
    const deal = await dealService.create({
      workspaceId: WS,
      data: { title: "Roof", pipelineId: "pipe-1", ownerId: null },
    })
    expect(deal.ownerId).toBeNull()
    expect(m.pickRoundRobin).not.toHaveBeenCalled()
  })

  test("assignOwner=none never picks", async () => {
    const deal = await dealService.create({
      workspaceId: WS,
      data: { title: "Roof", pipelineId: "pipe-1" },
    })
    expect(deal.ownerId).toBeNull()
    expect(m.pickRoundRobin).not.toHaveBeenCalled()
  })
})

describe("dealService viewer scope (s193)", () => {
  const ASSIGNED = {
    userId: "user-1",
    permissions: {
      superAdmin: false,
      contacts: false,
      onlyAssignedContacts: true,
    },
  }
  const SUPER = { userId: "user-1", permissions: { superAdmin: true } }
  const FULL = {
    userId: "user-1",
    permissions: {
      superAdmin: false,
      contacts: true,
      onlyAssignedContacts: false,
    },
  }

  test("an assigned-only viewer reading another owner's deal gets a 404, never a 403", async () => {
    m.findOrFail.mockImplementation(async () => ({
      ...OPEN_DEAL,
      ownerId: "user-2",
    }))
    await expect(
      dealService.findOrFail({
        workspaceId: WS,
        id: "deal-1",
        viewer: ASSIGNED,
      }),
    ).rejects.toMatchObject({ httpStatusCode: 404, message: "Deal not found" })
  })

  test("an assigned-only viewer reads their own deal; a super admin reads any", async () => {
    m.findOrFail.mockImplementation(async () => ({
      ...OPEN_DEAL,
      ownerId: "user-1",
    }))
    await expect(
      dealService.findOrFail({
        workspaceId: WS,
        id: "deal-1",
        viewer: ASSIGNED,
      }),
    ).resolves.toMatchObject({ ownerId: "user-1" })
    m.findOrFail.mockImplementation(async () => ({
      ...OPEN_DEAL,
      ownerId: "user-2",
    }))
    await expect(
      dealService.findOrFail({ workspaceId: WS, id: "deal-1", viewer: SUPER }),
    ).resolves.toMatchObject({ ownerId: "user-2" })
  })

  test("a members-only pipeline hides its deals from a non-member (404) and shows them to a member", async () => {
    m.pipelineFindOrFail.mockResolvedValue({
      ...PIPE("none"),
      settings: { ...PIPE("none").settings, access: "members" },
    })
    m.isMember.mockResolvedValueOnce(false)
    await expect(
      dealService.findOrFail({ workspaceId: WS, id: "deal-1", viewer: FULL }),
    ).rejects.toMatchObject({ httpStatusCode: 404 })
    m.isMember.mockResolvedValueOnce(true)
    await expect(
      dealService.findOrFail({ workspaceId: WS, id: "deal-1", viewer: FULL }),
    ).resolves.toMatchObject({ id: "deal-1" })
  })

  test("an assigned-only viewer creating a deal without an owner becomes the owner", async () => {
    m.state.member = { userId: "user-1" }
    const deal = await dealService.create({
      workspaceId: WS,
      data: { title: "Roof", pipelineId: "pipe-1" },
      viewer: ASSIGNED,
    })
    expect(deal.ownerId).toBe("user-1")
  })

  test("update / moveStage / setStatus / addNote / remove all refuse a hidden deal with 404 before any write", async () => {
    m.findOrFail.mockImplementation(async () => ({
      ...OPEN_DEAL,
      ownerId: "user-2",
    }))
    const base = { workspaceId: WS, id: "deal-1", viewer: ASSIGNED }
    await expect(
      dealService.update({ ...base, data: { title: "x" } }),
    ).rejects.toMatchObject({ httpStatusCode: 404 })
    await expect(
      dealService.moveStage({ ...base, stageId: "stage-won" }),
    ).rejects.toMatchObject({ httpStatusCode: 404 })
    await expect(
      dealService.setStatus({ ...base, status: "won" }),
    ).rejects.toMatchObject({ httpStatusCode: 404 })
    await expect(
      dealService.addNote({ ...base, text: "hi" }),
    ).rejects.toMatchObject({ httpStatusCode: 404 })
    await expect(
      dealService.remove({
        workspaceId: WS,
        ids: ["deal-1"],
        viewer: ASSIGNED,
      }),
    ).rejects.toMatchObject({ httpStatusCode: 404 })
    expect(
      m.calls.filter((c) => c.startsWith("activity") || c.startsWith("insert")),
    ).toEqual([])
  })

  test("list narrows to the viewer's owned deals and to visible pipelines", async () => {
    m.visibleIds.mockResolvedValueOnce(["pipe-1"])
    await dealService.list({ workspaceId: WS, viewer: ASSIGNED } as never)
    const where = m.state.lastListWhere as Record<string, unknown>
    expect(where.ownerId).toBe("user-1")
    expect(where.pipelineId).toEqual({ in: ["pipe-1"] })
  })

  test("list on a pipeline the viewer cannot see returns an empty page without a query", async () => {
    m.visibleIds.mockResolvedValueOnce(["pipe-2"])
    await expect(
      dealService.list({
        workspaceId: WS,
        pipelineId: "pipe-1",
        viewer: FULL,
      } as never),
    ).resolves.toEqual({ data: [], pageCount: 1 })
  })
})

describe("dealService.update re-link (s195)", () => {
  beforeEach(() => {
    m.calls.length = 0
    m.state.deal = {
      id: "deal-1",
      workspaceId: WS,
      title: "Roof",
      pipelineId: "pipe-1",
      stageId: "stage-1",
      status: "open",
      contactId: "contact-1",
      companyId: "co-1",
      ownerId: null,
      value: null,
      currency: "USD",
      priority: "medium",
      fields: {},
    }
    m.findOrFail.mockResolvedValue(m.state.deal)
  })

  test("a contact outside the workspace is a 404 and nothing is written", async () => {
    m.state.contact = null
    await expect(
      dealService.update({
        workspaceId: WS,
        id: "deal-1",
        data: { contactId: "contact-x" },
      }),
    ).rejects.toMatchObject({ code: "notFound" })
    expect(m.calls.filter((c) => c.startsWith("update:"))).toEqual([])
  })

  test("re-linking the contact writes contactChanged; the same contact is a no-op", async () => {
    m.state.contact = { id: "contact-2", companyId: null }
    m.state.updateReturning = [{ ...m.state.deal, contactId: "contact-2" }]
    await dealService.update({
      workspaceId: WS,
      id: "deal-1",
      data: { contactId: "contact-2" },
    })
    expect(m.calls).toEqual(["update:contactId", "activity:contactChanged"])
    m.calls.length = 0
    m.state.contact = { id: "contact-1", companyId: "co-1" }
    await dealService.update({
      workspaceId: WS,
      id: "deal-1",
      data: { contactId: "contact-1" },
    })
    expect(m.calls).toEqual([])
  })

  test("re-linking the company writes companyChanged and logs on the NEW company after commit", async () => {
    const { companyActivityService } = await import("../src/company/activity")
    m.state.updateReturning = [{ ...m.state.deal, companyId: "co-2" }]
    await dealService.update({
      workspaceId: WS,
      id: "deal-1",
      data: { companyId: "co-2" },
    })
    expect(m.calls).toEqual(["update:companyId", "activity:companyChanged"])
    expect(companyActivityService.recordSafely).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "co-2",
        type: "dealLinked",
        payload: expect.objectContaining({ dealId: "deal-1" }),
      }),
    )
  })

  test("clearing both links (null) is allowed and recorded", async () => {
    m.state.updateReturning = [
      { ...m.state.deal, contactId: null, companyId: null },
    ]
    await dealService.update({
      workspaceId: WS,
      id: "deal-1",
      data: { contactId: null, companyId: null },
    })
    expect(m.calls).toEqual([
      "update:contactId,companyId",
      "activity:contactChanged",
      "activity:companyChanged",
    ])
  })
})

describe("dealService.movePipeline (s196)", () => {
  const TARGET = (
    over: Partial<{
      access: "workspace" | "members"
      fieldDefs: typeof ROOF_DEFS | []
      stopCompanyOn: "none" | "created" | "won"
    }> = {},
  ) => ({
    id: "pipe-2",
    workspaceId: WS,
    settings: {
      stopCompanyOn: over.stopCompanyOn ?? "none",
      defaultCurrency: "USD",
      fieldDefs: over.fieldDefs ?? [],
      assignOwner: "none",
      access: over.access ?? "workspace",
    },
  })
  const T_STAGE = {
    id: "t-stage-1",
    pipelineId: "pipe-2",
    isWon: false,
    isLost: false,
  }
  const T_WON = {
    id: "t-won",
    pipelineId: "pipe-2",
    isWon: true,
    isLost: false,
  }
  const FULL = {
    userId: "user-1",
    permissions: {
      superAdmin: false,
      contacts: true,
      onlyAssignedContacts: false,
    },
  }
  const pipelines = (target: ReturnType<typeof TARGET>) =>
    m.pipelineFindOrFail.mockImplementation(async (p: { id: string }) =>
      p.id === "pipe-2" ? target : PIPE("none"),
    )
  const moved = (over: Record<string, unknown> = {}) => {
    m.state.updateReturning = [
      {
        ...OPEN_DEAL,
        pipelineId: "pipe-2",
        stageId: "t-stage-1",
        ...over,
      },
    ]
  }

  beforeEach(() => {
    pipelines(TARGET())
    m.firstStage.mockResolvedValue(T_STAGE)
    m.resolveStage.mockResolvedValue(T_STAGE)
  })

  test("moves into the target's first stage: CAS update, pipelineMoved activity, then emit with fromPipelineId, then the stage hook", async () => {
    const { onStageEntered, _resetStageEnteredHandlers } = await import(
      "../src/deal/stage-hooks"
    )
    _resetStageEnteredHandlers()
    const seen: string[] = []
    const off = onStageEntered((ctx) => {
      seen.push(`${ctx.deal.pipelineId}:${ctx.stageId}`)
      m.calls.push("hook:stage")
      return Promise.resolve()
    })
    try {
      moved()
      const deal = await dealService.movePipeline({
        workspaceId: WS,
        id: "deal-1",
        pipelineId: "pipe-2",
        actorId: "actor-1",
      })
      expect(deal.pipelineId).toBe("pipe-2")
      expect(m.firstStage).toHaveBeenCalledWith(
        expect.objectContaining({ pipelineId: "pipe-2" }),
      )
      expect(m.calls).toEqual([
        "advisory-lock",
        "update:pipelineId,stageId,position,fields,ownerId,status,closedAt",
        "activity:pipelineMoved",
        "emit:moved",
        "hook:stage",
      ])
      expect(m.state.activities[0]).toMatchObject({
        type: "pipelineMoved",
        actorId: "actor-1",
        payload: {
          fromPipelineId: "pipe-1",
          toPipelineId: "pipe-2",
          from: "stage-new",
          to: "t-stage-1",
        },
      })
      expect(m.emitMoved).toHaveBeenCalledWith(
        WS,
        "contact-1",
        expect.objectContaining({
          fromPipelineId: "pipe-1",
          fromStageId: "stage-new",
          pipelineId: "pipe-2",
          stageId: "t-stage-1",
        }),
      )
      expect(seen).toEqual(["pipe-2:t-stage-1"])
      // the deal row is locked before it is read (codex probe s196)
      expect(m.state.rowLocks[0]).toBe("update")
      // the lock key is the TARGET pipeline's one-open-deal key
      expect(JSON.stringify(m.state.executeArgs)).toContain(
        "deal:ws-1:contact-1:pipe-2",
      )
    } finally {
      off()
      _resetStageEnteredHandlers()
    }
  })

  test("an explicit stage is resolved against the TARGET pipeline; a foreign one is refused before any write", async () => {
    m.resolveStage.mockRejectedValueOnce(
      new Error("Stage is not in this pipeline."),
    )
    await expect(
      dealService.movePipeline({
        workspaceId: WS,
        id: "deal-1",
        pipelineId: "pipe-2",
        stageId: "stage-new",
      }),
    ).rejects.toThrow("Stage is not in this pipeline.")
    expect(m.resolveStage).toHaveBeenCalledWith(
      expect.objectContaining({ pipelineId: "pipe-2", stageId: "stage-new" }),
    )
    expect(m.calls).toEqual([])
  })

  test("the same pipeline is a 422 (that is moveStage)", async () => {
    await expect(
      dealService.movePipeline({
        workspaceId: WS,
        id: "deal-1",
        pipelineId: "pipe-1",
      }),
    ).rejects.toMatchObject({ httpStatusCode: 422, field: "pipelineId" })
    expect(m.calls).toEqual([])
  })

  test("a target the viewer cannot see is a 404 and nothing is written", async () => {
    m.pipelineFindOrFail.mockImplementation(
      (p: { id: string; viewer?: unknown }) => {
        if (p.id === "pipe-2" && p.viewer) {
          return Promise.reject(
            Object.assign(new Error("Pipeline not found"), {
              httpStatusCode: 404,
            }),
          )
        }
        return Promise.resolve(p.id === "pipe-2" ? TARGET() : PIPE("none"))
      },
    )
    await expect(
      dealService.movePipeline({
        workspaceId: WS,
        id: "deal-1",
        pipelineId: "pipe-2",
        viewer: FULL,
      }),
    ).rejects.toMatchObject({ httpStatusCode: 404 })
    expect(m.pipelineFindOrFail).toHaveBeenCalledWith(
      expect.objectContaining({ id: "pipe-2", viewer: FULL }),
    )
    expect(m.calls).toEqual([])
  })

  test("a deal the viewer cannot see is a 404 before the target is read", async () => {
    m.findOrFail.mockImplementation(async () => ({
      ...OPEN_DEAL,
      ownerId: "user-2",
    }))
    await expect(
      dealService.movePipeline({
        workspaceId: WS,
        id: "deal-1",
        pipelineId: "pipe-2",
        viewer: {
          userId: "user-1",
          permissions: {
            superAdmin: false,
            contacts: false,
            onlyAssignedContacts: true,
          },
        },
      }),
    ).rejects.toMatchObject({ httpStatusCode: 404, message: "Deal not found" })
    expect(m.calls).toEqual([])
  })

  test("a required target field the deal lacks is a 422 naming it; the patch supplies it", async () => {
    pipelines(TARGET({ fieldDefs: ROOF_DEFS }))
    await expect(
      dealService.movePipeline({
        workspaceId: WS,
        id: "deal-1",
        pipelineId: "pipe-2",
      }),
    ).rejects.toMatchObject({ httpStatusCode: 422, field: "fields.sqft" })
    expect(m.calls).toEqual([])

    moved({ fields: { sqft: 1200 } })
    await dealService.movePipeline({
      workspaceId: WS,
      id: "deal-1",
      pipelineId: "pipe-2",
      fields: { sqft: 1200 },
    })
    expect(m.calls[1]).toBe(
      "update:pipelineId,stageId,position,fields,ownerId,status,closedAt",
    )
  })

  test("a patch value of the wrong type for the target is a 422", async () => {
    pipelines(TARGET({ fieldDefs: ROOF_DEFS }))
    await expect(
      dealService.movePipeline({
        workspaceId: WS,
        id: "deal-1",
        pipelineId: "pipe-2",
        fields: { sqft: "a lot" },
      }),
    ).rejects.toMatchObject({ httpStatusCode: 422, field: "fields.sqft" })
  })

  test("fields that are not an object, or blow the size caps, are refused", async () => {
    await expect(
      dealService.movePipeline({
        workspaceId: WS,
        id: "deal-1",
        pipelineId: "pipe-2",
        fields: ["x"] as unknown as Record<string, unknown>,
      }),
    ).rejects.toMatchObject({ httpStatusCode: 422, field: "fields" })
    const tooMany = Object.fromEntries(
      Array.from({ length: 51 }, (_, i) => [`k${i}`, i]),
    )
    await expect(
      dealService.movePipeline({
        workspaceId: WS,
        id: "deal-1",
        pipelineId: "pipe-2",
        fields: tooMany,
      }),
    ).rejects.toMatchObject({ httpStatusCode: 422, field: "fields" })
    expect(m.calls).toEqual([])
  })

  test("an owner who cannot see a members-only target is a 422; reassigning or clearing moves it", async () => {
    pipelines(TARGET({ access: "members" }))
    m.findOrFail.mockImplementation(async () => ({
      ...OPEN_DEAL,
      ownerId: "owner-1",
    }))
    m.findMember.mockResolvedValue({
      userId: "owner-1",
      permissions: { superAdmin: false, contacts: true },
    })
    m.isMember.mockResolvedValue(false)
    await expect(
      dealService.movePipeline({
        workspaceId: WS,
        id: "deal-1",
        pipelineId: "pipe-2",
      }),
    ).rejects.toMatchObject({
      httpStatusCode: 422,
      field: "ownerId",
      data: { code: "ownerNotMember" },
    })
    expect(m.calls).toEqual([])

    // reassign to a member of the target
    m.state.member = { userId: "member-2" }
    m.findMember.mockResolvedValue({
      userId: "member-2",
      permissions: { superAdmin: false, contacts: true },
    })
    m.isMember.mockResolvedValue(true)
    moved({ ownerId: "member-2" })
    await dealService.movePipeline({
      workspaceId: WS,
      id: "deal-1",
      pipelineId: "pipe-2",
      ownerId: "member-2",
    })
    expect(m.state.activities.map((a) => a.type)).toEqual([
      "pipelineMoved",
      "assigned",
    ])
    expect(m.state.activities[1]).toMatchObject({
      payload: { from: "owner-1", to: "member-2" },
    })

    // clearing the owner needs no membership at all
    m.state.activities.length = 0
    m.state.member = null
    m.findMember.mockClear()
    moved({ ownerId: null })
    await dealService.movePipeline({
      workspaceId: WS,
      id: "deal-1",
      pipelineId: "pipe-2",
      ownerId: null,
    })
    expect(m.findMember).not.toHaveBeenCalled()
    expect(m.state.activities.map((a) => a.type)).toEqual([
      "pipelineMoved",
      "assigned",
    ])
  })

  test("a super-admin owner may stay on a members-only target without membership", async () => {
    pipelines(TARGET({ access: "members" }))
    m.findOrFail.mockImplementation(async () => ({
      ...OPEN_DEAL,
      ownerId: "owner-1",
    }))
    m.findMember.mockResolvedValue({
      userId: "owner-1",
      permissions: { superAdmin: true },
    })
    m.isMember.mockResolvedValue(false)
    moved({ ownerId: "owner-1" })
    await dealService.movePipeline({
      workspaceId: WS,
      id: "deal-1",
      pipelineId: "pipe-2",
    })
    expect(m.state.activities.map((a) => a.type)).toEqual(["pipelineMoved"])
  })

  test("an owner who left the workspace cannot stay on a members-only target", async () => {
    pipelines(TARGET({ access: "members" }))
    m.findOrFail.mockImplementation(async () => ({
      ...OPEN_DEAL,
      ownerId: "gone-1",
    }))
    m.findMember.mockResolvedValue(undefined)
    await expect(
      dealService.movePipeline({
        workspaceId: WS,
        id: "deal-1",
        pipelineId: "pipe-2",
      }),
    ).rejects.toMatchObject({ field: "ownerId" })
  })

  test("landing open where the contact already has an open deal is refused under the lock", async () => {
    m.state.openDeal = { ...OPEN_DEAL, id: "deal-other", pipelineId: "pipe-2" }
    await expect(
      dealService.movePipeline({
        workspaceId: WS,
        id: "deal-1",
        pipelineId: "pipe-2",
      }),
    ).rejects.toMatchObject({
      httpStatusCode: 422,
      field: "pipelineId",
      data: { conflict: "openDeal", dealId: "deal-other" },
    })
    expect(m.calls).toEqual(["advisory-lock"])
  })

  test("landing on a won stage closes the deal IN the move's transaction (no second setStatus), skips the open-deal check, then emits + stops", async () => {
    pipelines(TARGET({ stopCompanyOn: "won" }))
    m.resolveStage.mockResolvedValue(T_WON)
    m.state.openDeal = { ...OPEN_DEAL, id: "deal-other", pipelineId: "pipe-2" }
    moved({ stageId: "t-won", status: "won" })
    await dealService.movePipeline({
      workspaceId: WS,
      id: "deal-1",
      pipelineId: "pipe-2",
      stageId: "t-won",
    })
    expect(m.calls).toEqual([
      "update:pipelineId,stageId,position,fields,ownerId,status,closedAt",
      "activity:pipelineMoved",
      "activity:statusChanged",
      "emit:moved",
      "emit:status",
      "stop:company",
    ])
    // one deal read only: setStatus (which re-reads the deal) never ran
    expect(m.findOrFail).toHaveBeenCalledTimes(1)
  })

  test("a WON deal moved onto an open stage reopens under the lock: an open deal already there refuses it (skeptic s196)", async () => {
    m.findOrFail.mockImplementation(async () => ({
      ...OPEN_DEAL,
      status: "won",
    }))
    m.state.openDeal = { ...OPEN_DEAL, id: "deal-other", pipelineId: "pipe-2" }
    await expect(
      dealService.movePipeline({
        workspaceId: WS,
        id: "deal-1",
        pipelineId: "pipe-2",
      }),
    ).rejects.toMatchObject({ data: { conflict: "openDeal" } })
    expect(m.calls).toEqual(["advisory-lock"])

    m.state.openDeal = null
    moved({ status: "open" })
    await dealService.movePipeline({
      workspaceId: WS,
      id: "deal-1",
      pipelineId: "pipe-2",
    })
    expect(m.calls.slice(1, 5)).toEqual([
      "advisory-lock",
      "update:pipelineId,stageId,position,fields,ownerId,status,closedAt",
      "activity:pipelineMoved",
      "activity:statusChanged",
    ])
    expect(m.state.activities.at(-1)).toMatchObject({
      type: "statusChanged",
      payload: { from: "won", to: "open" },
    })
  })

  test("a WON deal moved onto a LOST stage goes won -> lost directly (setStatus would refuse it after the move)", async () => {
    m.findOrFail.mockImplementation(async () => ({
      ...OPEN_DEAL,
      status: "won",
    }))
    m.resolveStage.mockResolvedValue({
      ...T_WON,
      id: "t-lost",
      isWon: false,
      isLost: true,
    })
    moved({ stageId: "t-lost", status: "lost" })
    await dealService.movePipeline({
      workspaceId: WS,
      id: "deal-1",
      pipelineId: "pipe-2",
      stageId: "t-lost",
    })
    expect(m.state.activities.map((a) => a.type)).toEqual([
      "pipelineMoved",
      "statusChanged",
    ])
    expect(m.emitStatus).toHaveBeenCalledWith(
      WS,
      "contact-1",
      expect.objectContaining({ oldStatus: "won" }),
    )
    expect(m.stopCompany).not.toHaveBeenCalled()
  })

  test("a deal without a contact takes no lock and emits nothing", async () => {
    m.findOrFail.mockImplementation(async () => ({
      ...OPEN_DEAL,
      contactId: null,
    }))
    moved({ contactId: null })
    await dealService.movePipeline({
      workspaceId: WS,
      id: "deal-1",
      pipelineId: "pipe-2",
    })
    expect(m.calls).not.toContain("advisory-lock")
    expect(m.emitMoved).not.toHaveBeenCalled()
  })

  test("a concurrent move (0 rows) is a stale conflict and records nothing", async () => {
    m.state.updateEmpty = true
    await expect(
      dealService.movePipeline({
        workspaceId: WS,
        id: "deal-1",
        pipelineId: "pipe-2",
      }),
    ).rejects.toMatchObject({ data: { conflict: "stale" } })
    expect(m.state.activities).toEqual([])
    expect(m.emitMoved).not.toHaveBeenCalled()
  })
})

describe("dealService.listBoard card counts (s198)", () => {
  const stage = (id: string) => ({ id, name: id, pipelineId: "pipe-1" })
  const deal = (id: string, stageId: string) => ({
    id,
    stageId,
    workspaceId: WS,
    pipelineId: "pipe-1",
    title: id,
  })
  beforeEach(() => {
    m.state.boardDeals = []
    m.state.groupResults = []
    m.state.groupByCalls = 0
    m.pipelineFind.mockResolvedValue({
      id: "pipe-1",
      stages: [stage("s-1"), stage("s-2")],
    })
  })

  test("merges open / overdue task and comment counts; a deal with none gets zeros", async () => {
    m.state.boardDeals = [
      deal("d-1", "s-1"),
      deal("d-2", "s-1"),
      deal("d-3", "s-2"),
    ]
    m.state.groupResults = [
      [
        { dealId: "d-1", open: 3, overdue: 1 },
        { dealId: "d-3", open: 0, overdue: 0 },
      ],
      [{ dealId: "d-2", count: "4" }],
    ]
    const board = await dealService.listBoard({
      workspaceId: WS,
      pipelineId: "pipe-1",
    })
    const cards = board.flatMap((c) => c.deals)
    expect(
      cards.map((d) => [
        d.id,
        d.openTaskCount,
        d.overdueTaskCount,
        d.commentCount,
      ]),
    ).toEqual([
      ["d-1", 3, 1, 0],
      ["d-2", 0, 0, 4],
      ["d-3", 0, 0, 0],
    ])
    expect(board.map((c) => c.deals.map((d) => d.id))).toEqual([
      ["d-1", "d-2"],
      ["d-3"],
    ])
    expect(m.state.groupByCalls).toBe(2)
  })

  test("an empty board runs no count query", async () => {
    const board = await dealService.listBoard({
      workspaceId: WS,
      pipelineId: "pipe-1",
    })
    expect(board.map((c) => c.deals)).toEqual([[], []])
    expect(m.state.groupByCalls).toBe(0)
  })

  test("the count queries carry the board's own Deal predicates, incl. the assigned-only owner", async () => {
    const { eq } = (await import(
      "@chatbotx.io/database/client"
    )) as unknown as {
      eq: ReturnType<typeof vi.fn>
    }
    eq.mockClear()
    m.state.boardDeals = [deal("d-1", "s-1")]
    await dealService.listBoard({
      workspaceId: WS,
      pipelineId: "pipe-1",
      status: "open",
      viewer: {
        userId: "user-1",
        permissions: {
          superAdmin: false,
          contacts: false,
          onlyAssignedContacts: true,
        },
      } as never,
    })
    const bound = eq.mock.calls.map((c) => c[1])
    expect(bound).toEqual(
      expect.arrayContaining([WS, "pipe-1", "open", "user-1"]),
    )
    expect(m.state.lastListWhere).toMatchObject({
      ownerId: "user-1",
      status: "open",
    })
  })
})
