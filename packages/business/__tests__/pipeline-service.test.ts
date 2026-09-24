import { beforeEach, describe, expect, test, vi } from "vitest"

const m = vi.hoisted(() => {
  const state = {
    pipelines: [] as Record<string, unknown>[],
    stages: [] as Record<string, unknown>[],
    findFirst: undefined as Record<string, unknown> | undefined,
    count: 0,
    resolveStageRow: null as Record<string, unknown> | null,
  }
  const inserted: Record<string, unknown>[] = []
  const updated: Record<string, unknown>[] = []
  const deleted: string[] = []
  const selectChain: Record<string, unknown> = {}
  selectChain.from = (table: { name?: string }) => {
    selectChain.table = table
    return selectChain
  }
  selectChain.where = () => selectChain
  selectChain.innerJoin = () => selectChain
  selectChain.limit = () =>
    Promise.resolve(
      state.resolveStageRow ? [{ stage: state.resolveStageRow }] : [],
    )
  // the max() query resolves as an awaited chain
  // biome-ignore lint/suspicious/noThenProperty: awaited query-builder stub
  selectChain.then = (resolve: (v: unknown) => unknown) =>
    resolve([{ maxOrder: 2000 }])
  const db: Record<string, unknown> = {
    transaction: (cb: (tx: unknown) => unknown) => cb(db),
    query: {
      pipelineModel: {
        findFirst: vi.fn(async () => state.findFirst),
        findMany: vi.fn(async () => state.pipelines),
      },
      pipelineStageModel: {
        findMany: vi.fn(async () => state.stages),
      },
    },
    $count: vi.fn(async () => state.count),
    select: () => selectChain,
    insert: () => ({
      values: (v: Record<string, unknown> | Record<string, unknown>[]) => {
        const rows = Array.isArray(v) ? v : [v]
        inserted.push(...rows)
        return { returning: () => Promise.resolve(rows) }
      },
    }),
    update: () => {
      const chain = {
        set: (v: Record<string, unknown>) => {
          updated.push(v)
          return chain
        },
        where: () => chain,
        returning: () =>
          Promise.resolve([{ id: "stage-1", ...updated.at(-1) }]),
        // biome-ignore lint/suspicious/noThenProperty: awaited query-builder stub
        then: (resolve: (v: unknown) => unknown) => resolve(undefined),
      }
      return chain
    },
    delete: () => ({
      where: () => {
        deleted.push("row")
        return { returning: () => Promise.resolve([{ id: "x" }]) }
      },
    }),
  }
  return { state, inserted, updated, deleted, db, findOrFail: vi.fn() }
})

vi.mock("@chatbotx.io/database/client", () => ({
  db: m.db,
  and: vi.fn((...c: unknown[]) => ({ c })),
  eq: vi.fn((f: unknown, v: unknown) => ({ f, v })),
  inArray: vi.fn((f: unknown, v: unknown) => ({ f, v })),
  sql: vi.fn((s: TemplateStringsArray, ...v: unknown[]) => ({ s, v })),
  findOrFail: (...a: unknown[]) => m.findOrFail(...a),
}))
vi.mock("@chatbotx.io/utils", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createId: () => "new-id",
}))
vi.mock("../src/audit/dispatcher", () => ({ dispatchAuditRecord: vi.fn() }))

const { pipelineService } = await import("../src/pipeline/service")

const WS = "ws-1"

beforeEach(() => {
  vi.clearAllMocks()
  m.inserted.length = 0
  m.updated.length = 0
  m.deleted.length = 0
  m.state.pipelines = []
  m.state.stages = []
  m.state.findFirst = undefined
  m.state.count = 0
  m.state.resolveStageRow = null
  m.findOrFail.mockResolvedValue({
    id: "pipe-1",
    workspaceId: WS,
    settings: { stopCompanyOn: "created", defaultCurrency: "USD" },
  })
})

describe("pipelineService.create", () => {
  test("seeds the four default stages (New, Qualified, Won, Lost) with settings written explicitly", async () => {
    const pipeline = await pipelineService.create({
      workspaceId: WS,
      data: { name: " Sales " },
    })
    expect(pipeline.name).toBe("Sales")
    expect(pipeline.settings).toEqual({
      stopCompanyOn: "created",
      defaultCurrency: "USD",
      fieldDefs: [],
    })
    expect(pipeline.stages.map((s) => s.name)).toEqual([
      "New",
      "Qualified",
      "Won",
      "Lost",
    ])
    expect(pipeline.stages.map((s) => s.order)).toEqual([
      1000, 2000, 3000, 4000,
    ])
    expect(pipeline.stages.filter((s) => s.isWon)).toHaveLength(1)
    expect(m.inserted[0]).toHaveProperty("settings")
  })

  test("custom settings + custom stages", async () => {
    const pipeline = await pipelineService.create({
      workspaceId: WS,
      data: {
        name: "Support",
        settings: { stopCompanyOn: "won", defaultCurrency: "eur" },
        stages: [{ name: "Open" }, { name: "Done", isWon: true }],
      },
    })
    expect(pipeline.settings).toEqual({
      stopCompanyOn: "won",
      defaultCurrency: "EUR",
      fieldDefs: [],
    })
    expect(pipeline.stages).toHaveLength(2)
  })

  test.each([
    [{ name: "" }, "empty name"],
    [{ name: "x", settings: { stopCompanyOn: "always" } }, "bad stopCompanyOn"],
    [{ name: "x", settings: { extra: 1 } }, "unknown settings key"],
    [{ name: "x", stages: [{ name: "" }] }, "empty stage name"],
    [
      { name: "x", stages: [{ name: "a", isWon: true, isLost: true }] },
      "won and lost",
    ],
    [
      { name: "x", stages: [{ name: "a", probability: 101 }] },
      "probability > 100",
    ],
    [
      { name: "x", stages: [{ name: "a", probability: 1.5 }] },
      "fractional probability",
    ],
  ])("rejects %j (%s)", async (data) => {
    await expect(
      pipelineService.create({ workspaceId: WS, data: data as never }),
    ).rejects.toThrow()
    expect(m.inserted).toHaveLength(0)
  })

  test("duplicate name is refused", async () => {
    m.state.findFirst = { id: "existing" }
    await expect(
      pipelineService.create({ workspaceId: WS, data: { name: "Sales" } }),
    ).rejects.toThrow("Name is already taken.")
  })
})

describe("pipelineService.remove", () => {
  test("refuses while open deals exist unless force", async () => {
    m.state.count = 3
    await expect(
      pipelineService.remove({ workspaceId: WS, id: "pipe-1" }),
    ).rejects.toThrow("3 open deal(s)")
    expect(m.deleted).toHaveLength(0)
    await expect(
      pipelineService.remove({ workspaceId: WS, id: "pipe-1", force: true }),
    ).resolves.toEqual({ deletedDeals: 1 })
    // deals are deleted explicitly BEFORE the pipeline row (RESTRICT on stageId)
    expect(m.deleted).toHaveLength(2)
  })
})

describe("pipelineService.resolveStage", () => {
  test("a stage of another pipeline is a validation error, not a hit", async () => {
    m.state.resolveStageRow = null
    await expect(
      pipelineService.resolveStage({
        workspaceId: WS,
        pipelineId: "pipe-1",
        stageId: "s-9",
      }),
    ).rejects.toThrow("Stage is not in this pipeline.")
  })
})

describe("pipelineService.removeStage", () => {
  beforeEach(() => {
    m.state.resolveStageRow = { id: "stage-1", pipelineId: "pipe-1" }
  })

  test("the last stage cannot be removed", async () => {
    m.db.$count.mockResolvedValueOnce(1)
    await expect(
      pipelineService.removeStage({
        workspaceId: WS,
        pipelineId: "pipe-1",
        stageId: "stage-1",
      }),
    ).rejects.toThrow("at least one stage")
  })

  test("refuses when deals remain and no target is given", async () => {
    m.db.$count.mockResolvedValueOnce(4).mockResolvedValueOnce(2)
    await expect(
      pipelineService.removeStage({
        workspaceId: WS,
        pipelineId: "pipe-1",
        stageId: "stage-1",
      }),
    ).rejects.toThrow("2 deal(s) are in this stage")
    expect(m.deleted).toHaveLength(0)
  })

  test("refuses moving deals onto the stage being removed", async () => {
    m.db.$count.mockResolvedValueOnce(4).mockResolvedValueOnce(2)
    await expect(
      pipelineService.removeStage({
        workspaceId: WS,
        pipelineId: "pipe-1",
        stageId: "stage-1",
        moveDealsTo: "stage-1",
      }),
    ).rejects.toThrow("pick a stage")
  })

  test("moves deals to the target then deletes", async () => {
    m.db.$count.mockResolvedValueOnce(4).mockResolvedValueOnce(2)
    const result = await pipelineService.removeStage({
      workspaceId: WS,
      pipelineId: "pipe-1",
      stageId: "stage-1",
      moveDealsTo: "stage-2",
    })
    expect(result.movedDeals).toBe(1)
    expect(m.updated.at(-1)).toEqual({ stageId: "stage-2" })
    expect(m.deleted).toHaveLength(1)
  })
})

describe("pipelineService.reorderStages", () => {
  test("every id must belong to the pipeline", async () => {
    m.state.stages = [{ id: "a" }]
    await expect(
      pipelineService.reorderStages({
        workspaceId: WS,
        pipelineId: "pipe-1",
        stageIds: ["a", "b"],
      }),
    ).rejects.toThrow("Every stage must belong")
  })
})
