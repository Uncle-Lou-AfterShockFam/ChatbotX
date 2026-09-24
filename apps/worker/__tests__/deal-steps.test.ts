import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, test, vi } from "vitest"

const m = vi.hoisted(() => ({
  findOpen: vi.fn(),
  create: vi.fn(),
  createUnlessOpen: vi.fn(),
  moveStage: vi.fn(),
  movePipeline: vi.fn(),
  setStatus: vi.fn(),
  getAll: vi.fn(),
  replaceAll: vi.fn(),
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}))

vi.mock("@chatbotx.io/business/deal", () => ({
  dealService: {
    findOpenForContactInPipeline: (...a: unknown[]) => m.findOpen(...a),
    create: (...a: unknown[]) => m.create(...a),
    createUnlessOpen: (...a: unknown[]) => m.createUnlessOpen(...a),
    moveStage: (...a: unknown[]) => m.moveStage(...a),
    movePipeline: (...a: unknown[]) => m.movePipeline(...a),
    setStatus: (...a: unknown[]) => m.setStatus(...a),
  },
}))
vi.mock("@chatbotx.io/variables", () => ({
  contactVariableService: {
    getAll: (...a: unknown[]) => m.getAll(...a),
    replaceAll: (...a: unknown[]) => m.replaceAll(...a),
  },
}))
vi.mock("../src/lib/logger", () => ({
  logger: { error: m.logError, info: m.logInfo, warn: m.logWarn },
}))

const { createDeal, moveDealStage, setDealStatus } = await import(
  "../src/integration/handlers/deal"
)

const conversation = { workspaceId: "ws-1", contactId: "contact-1" }
const props = (step: Record<string, unknown>) =>
  ({ conversation, contactInbox: { id: "ci-1" }, step }) as never

beforeEach(() => {
  vi.clearAllMocks()
  m.findOpen.mockResolvedValue(undefined)
  m.getAll.mockResolvedValue({})
  m.replaceAll.mockImplementation(({ text }: { text: string }) =>
    Promise.resolve(text.replace("{{contact.full_name}}", "Lou")),
  )
  m.create.mockResolvedValue({ id: "deal-1" })
  m.createUnlessOpen.mockResolvedValue({
    deal: { id: "deal-1" },
    created: true,
  })
})

describe("worker registration", () => {
  test("the three deal steps are wired in step.ts", () => {
    const source = readFileSync("src/integration/handlers/step.ts", "utf8")
    expect(source).toContain("[stepTypes.enum.createDeal]: createDeal")
    expect(source).toContain("[stepTypes.enum.moveDealStage]: moveDealStage")
    expect(source).toContain("[stepTypes.enum.setDealStatus]: setDealStatus")
  })
})

describe("createDeal step", () => {
  const step = {
    id: "s1",
    stepType: "createDeal",
    pipelineId: "pipe-1",
    stageId: undefined,
    title: "Deal for {{contact.full_name}}",
    value: " 250 ",
    currency: "",
    priority: "high",
    skipIfOpenDealExists: true,
  }

  test("resolves variables and creates for the conversation contact (locked path when skipIfOpenDealExists)", async () => {
    await createDeal(props(step))
    expect(m.create).not.toHaveBeenCalled()
    expect(m.createUnlessOpen).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      data: {
        pipelineId: "pipe-1",
        stageId: null,
        title: "Deal for Lou",
        value: " 250 ",
        currency: null,
        priority: "high",
        contactId: "contact-1",
        // undefined, not null: lets the pipeline's round-robin pick (s193)
        ownerId: undefined,
        dueAt: null,
      },
    })
  })

  test("passes the owner and computes dueAt = now + dueInDays (s192)", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-24T00:00:00Z") })
    try {
      await createDeal(props({ ...step, ownerId: "user-9", dueInDays: 7 }))
    } finally {
      vi.useRealTimers()
    }
    expect(m.createUnlessOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          ownerId: "user-9",
          dueAt: new Date("2026-10-01T00:00:00Z"),
        }),
      }),
    )
  })

  test("a configured owner who left the workspace: retries ownerless with a warning instead of dropping the deal (skeptic MEDIUM, s192)", async () => {
    m.createUnlessOpen
      .mockRejectedValueOnce(
        new Error("Owner is not a member of this workspace."),
      )
      .mockResolvedValueOnce({ deal: { id: "deal-2" }, created: true })
    await createDeal(props({ ...step, ownerId: "gone-user" }))
    expect(m.createUnlessOpen).toHaveBeenCalledTimes(2)
    expect(m.createUnlessOpen.mock.calls[0][0].data.ownerId).toBe("gone-user")
    expect(m.createUnlessOpen.mock.calls[1][0].data.ownerId).toBeNull()
    expect(m.logWarn).toHaveBeenCalledTimes(1)
    expect(m.logError).not.toHaveBeenCalled()
  })

  test("any other create failure is logged once and NOT retried", async () => {
    m.createUnlessOpen.mockRejectedValueOnce(new Error("Pipeline not found"))
    await createDeal(props({ ...step, ownerId: "user-9" }))
    expect(m.createUnlessOpen).toHaveBeenCalledTimes(1)
    expect(m.logError).toHaveBeenCalledTimes(1)
  })

  test("dueInDays 0 is due today, not 'no due date'", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-24T12:00:00Z") })
    try {
      await createDeal(props({ ...step, dueInDays: 0 }))
    } finally {
      vi.useRealTimers()
    }
    expect(m.createUnlessOpen.mock.calls[0][0].data.dueAt).toEqual(
      new Date("2026-09-24T12:00:00Z"),
    )
  })

  test("logs the skip when the service found an open deal (no TOCTOU: the check lives under the service lock)", async () => {
    m.createUnlessOpen.mockResolvedValue({
      deal: { id: "deal-0" },
      created: false,
    })
    await createDeal(props(step))
    expect(m.create).not.toHaveBeenCalled()
    expect(m.logInfo.mock.calls[0][1]).toContain("skipped")
  })

  test("creates unconditionally when skipIfOpenDealExists is off", async () => {
    await createDeal(props({ ...step, skipIfOpenDealExists: false }))
    expect(m.createUnlessOpen).not.toHaveBeenCalled()
    expect(m.create).toHaveBeenCalledTimes(1)
  })

  test("no pipeline = warn and no write", async () => {
    await createDeal(props({ ...step, pipelineId: undefined }))
    expect(m.create).not.toHaveBeenCalled()
    expect(m.logWarn).toHaveBeenCalled()
  })

  test("an empty resolved title falls back; an empty value becomes null", async () => {
    await createDeal(
      props({ ...step, title: "", value: "", skipIfOpenDealExists: false }),
    )
    expect(m.create.mock.calls[0][0].data).toMatchObject({
      title: "Deal for contact-1",
      value: null,
    })
  })

  test("a service error is logged, never thrown", async () => {
    m.createUnlessOpen.mockRejectedValue(
      new Error("Stage is not in this pipeline."),
    )
    await expect(createDeal(props(step))).resolves.toBeUndefined()
    expect(m.logError).toHaveBeenCalled()
  })
})

describe("moveDealStage step across pipelines (s196)", () => {
  const cross = (over: Record<string, unknown> = {}) =>
    props({
      id: "s2",
      stepType: "moveDealStage",
      pipelineId: "p",
      targetPipelineId: "p2",
      ...over,
    })

  test("a target pipeline moves the open deal there; no stage = the target's first", async () => {
    m.findOpen.mockResolvedValue({ id: "deal-7" })
    await moveDealStage(cross())
    expect(m.findOpen).toHaveBeenCalledWith(
      expect.objectContaining({ pipelineId: "p" }),
    )
    expect(m.movePipeline).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      id: "deal-7",
      pipelineId: "p2",
      stageId: null,
    })
    expect(m.moveStage).not.toHaveBeenCalled()
  })

  test("a target stage rides along", async () => {
    m.findOpen.mockResolvedValue({ id: "deal-7" })
    await moveDealStage(cross({ stageId: "t-s" }))
    expect(m.movePipeline).toHaveBeenCalledWith(
      expect.objectContaining({ pipelineId: "p2", stageId: "t-s" }),
    )
  })

  test("target = source pipeline is a plain stage move", async () => {
    m.findOpen.mockResolvedValue({ id: "deal-7" })
    await moveDealStage(cross({ targetPipelineId: "p", stageId: "s" }))
    expect(m.movePipeline).not.toHaveBeenCalled()
    expect(m.moveStage).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      id: "deal-7",
      stageId: "s",
    })
  })

  test("a refused move (422) is logged and the flow continues", async () => {
    m.findOpen.mockResolvedValue({ id: "deal-7" })
    m.movePipeline.mockRejectedValueOnce(new Error('Field "sqft" is required.'))
    await expect(moveDealStage(cross())).resolves.toBeUndefined()
    expect(m.logError).toHaveBeenCalled()
  })

  test("no source pipeline = warn, no read", async () => {
    await moveDealStage(cross({ pipelineId: undefined }))
    expect(m.findOpen).not.toHaveBeenCalled()
    expect(m.movePipeline).not.toHaveBeenCalled()
  })
})

describe("moveDealStage / setDealStatus steps", () => {
  test("no open deal = info log, no write", async () => {
    await moveDealStage(
      props({
        id: "s2",
        stepType: "moveDealStage",
        pipelineId: "p",
        stageId: "s",
      }),
    )
    await setDealStatus(
      props({
        id: "s3",
        stepType: "setDealStatus",
        pipelineId: "p",
        status: "won",
      }),
    )
    expect(m.moveStage).not.toHaveBeenCalled()
    expect(m.setStatus).not.toHaveBeenCalled()
    expect(m.logInfo).toHaveBeenCalledTimes(2)
  })

  test("with an open deal both act on it", async () => {
    m.findOpen.mockResolvedValue({ id: "deal-7" })
    await moveDealStage(
      props({
        id: "s2",
        stepType: "moveDealStage",
        pipelineId: "p",
        stageId: "s",
      }),
    )
    await setDealStatus(
      props({
        id: "s3",
        stepType: "setDealStatus",
        pipelineId: "p",
        status: "lost",
      }),
    )
    expect(m.moveStage).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      id: "deal-7",
      stageId: "s",
    })
    expect(m.setStatus).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      id: "deal-7",
      status: "lost",
    })
  })

  test("missing pipeline/stage = warn, no lookup", async () => {
    await moveDealStage(
      props({ id: "s2", stepType: "moveDealStage", pipelineId: "p" }),
    )
    await setDealStatus(
      props({ id: "s3", stepType: "setDealStatus", status: "won" }),
    )
    expect(m.findOpen).not.toHaveBeenCalled()
    expect(m.logWarn).toHaveBeenCalledTimes(2)
  })

  test("a thrown validation (won -> lost) is logged, never thrown", async () => {
    m.findOpen.mockResolvedValue({ id: "deal-7" })
    m.setStatus.mockRejectedValue(new Error("reopen it"))
    await expect(
      setDealStatus(
        props({
          id: "s3",
          stepType: "setDealStatus",
          pipelineId: "p",
          status: "lost",
        }),
      ),
    ).resolves.toBeUndefined()
    expect(m.logError).toHaveBeenCalled()
  })
})
