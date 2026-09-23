import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, test, vi } from "vitest"

const m = vi.hoisted(() => ({
  findOpen: vi.fn(),
  create: vi.fn(),
  moveStage: vi.fn(),
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
    moveStage: (...a: unknown[]) => m.moveStage(...a),
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

  test("resolves variables and creates for the conversation contact", async () => {
    await createDeal(props(step))
    expect(m.create).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      data: {
        pipelineId: "pipe-1",
        stageId: null,
        title: "Deal for Lou",
        value: " 250 ",
        currency: null,
        priority: "high",
        contactId: "contact-1",
      },
    })
  })

  test("skips when an open deal exists (skipIfOpenDealExists)", async () => {
    m.findOpen.mockResolvedValue({ id: "deal-0" })
    await createDeal(props(step))
    expect(m.create).not.toHaveBeenCalled()
    expect(m.logInfo).toHaveBeenCalled()
  })

  test("creates a second deal when skipIfOpenDealExists is off", async () => {
    m.findOpen.mockResolvedValue({ id: "deal-0" })
    await createDeal(props({ ...step, skipIfOpenDealExists: false }))
    expect(m.findOpen).not.toHaveBeenCalled()
    expect(m.create).toHaveBeenCalledTimes(1)
  })

  test("no pipeline = warn and no write", async () => {
    await createDeal(props({ ...step, pipelineId: undefined }))
    expect(m.create).not.toHaveBeenCalled()
    expect(m.logWarn).toHaveBeenCalled()
  })

  test("an empty resolved title falls back; an empty value becomes null", async () => {
    await createDeal(props({ ...step, title: "", value: "" }))
    expect(m.create.mock.calls[0][0].data).toMatchObject({
      title: "Deal for contact-1",
      value: null,
    })
  })

  test("a service error is logged, never thrown", async () => {
    m.create.mockRejectedValue(new Error("Stage is not in this pipeline."))
    await expect(createDeal(props(step))).resolves.toBeUndefined()
    expect(m.logError).toHaveBeenCalled()
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
