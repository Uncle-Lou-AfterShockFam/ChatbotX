import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, test, vi } from "vitest"

const m = vi.hoisted(() => ({
  findOpen: vi.fn(),
  taskCreate: vi.fn(),
  taskList: vi.fn(),
  taskComplete: vi.fn(),
  getAll: vi.fn(),
  replaceAll: vi.fn(),
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}))

vi.mock("@chatbotx.io/business/deal", () => ({
  dealService: { findOpenForContactInPipeline: m.findOpen },
}))
vi.mock("@chatbotx.io/business/deal-task", () => ({
  dealTaskService: {
    create: m.taskCreate,
    list: m.taskList,
    complete: m.taskComplete,
  },
}))
vi.mock("@chatbotx.io/variables", () => ({
  contactVariableService: { getAll: m.getAll, replaceAll: m.replaceAll },
}))
vi.mock("../src/lib/logger", () => ({
  logger: { error: m.logError, info: m.logInfo, warn: m.logWarn },
}))

const { createTask, completeTask } = await import(
  "../src/integration/handlers/deal"
)

const conversation = { workspaceId: "ws-1", contactId: "contact-1" }
const props = (step: Record<string, unknown>) =>
  ({ conversation, contactInbox: { id: "ci-1" }, step }) as never
const OPEN = { id: "deal-1", ownerId: "owner-1" }

beforeEach(() => {
  vi.clearAllMocks()
  m.findOpen.mockResolvedValue(OPEN)
  m.getAll.mockResolvedValue({})
  m.replaceAll.mockImplementation(({ text }: { text: string }) =>
    Promise.resolve(text.replace("{{contact.full_name}}", "Lou")),
  )
  m.taskCreate.mockResolvedValue({ id: "task-1" })
  m.taskComplete.mockResolvedValue({ completed: true })
})

describe("worker registration", () => {
  test("both task steps are wired in step.ts", () => {
    const source = readFileSync("src/integration/handlers/step.ts", "utf8")
    expect(source).toContain("[stepTypes.enum.createTask]: createTask")
    expect(source).toContain("[stepTypes.enum.completeTask]: completeTask")
  })
})

describe("createTask step", () => {
  const step = {
    id: "s1",
    stepType: "createTask",
    pipelineId: "pipe-1",
    title: "Call {{contact.full_name}}",
    description: "",
    startInDays: 1,
    dueInDays: 2,
    assignTo: "dealOwner",
  }

  test("creates on the contact's open deal: variables resolved, owner assigned, startAt / dueAt = now + days", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-24T00:00:00Z") })
    try {
      await createTask(props(step))
    } finally {
      vi.useRealTimers()
    }
    expect(m.taskCreate).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      dealId: "deal-1",
      data: {
        title: "Call Lou",
        description: null,
        startAt: new Date("2026-09-25T00:00:00Z"),
        dueAt: new Date("2026-09-26T00:00:00Z"),
        assigneeId: "owner-1",
      },
    })
  })

  test("a start after the due date is clamped to the due date: the task is still created", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-24T00:00:00Z") })
    try {
      await createTask(props({ ...step, startInDays: 9, dueInDays: 2 }))
    } finally {
      vi.useRealTimers()
    }
    expect(m.taskCreate.mock.calls[0][0].data).toMatchObject({
      startAt: new Date("2026-09-26T00:00:00Z"),
      dueAt: new Date("2026-09-26T00:00:00Z"),
    })
  })

  test("no open deal -> logs and skips; no pipeline -> warns and skips", async () => {
    m.findOpen.mockResolvedValue(undefined)
    await createTask(props(step))
    expect(m.taskCreate).not.toHaveBeenCalled()
    await createTask(props({ ...step, pipelineId: undefined }))
    expect(m.logWarn).toHaveBeenCalledTimes(1)
  })

  test("assignTo user with a departed member: one unassigned retry + warn; other errors logged once", async () => {
    m.taskCreate
      .mockRejectedValueOnce(
        new Error("Assignee is not a member of this workspace."),
      )
      .mockResolvedValueOnce({ id: "task-2" })
    await createTask(props({ ...step, assignTo: "user", assigneeId: "gone" }))
    expect(m.taskCreate).toHaveBeenCalledTimes(2)
    expect(m.taskCreate.mock.calls[1][0].data.assigneeId).toBeNull()
    expect(m.logWarn).toHaveBeenCalledTimes(1)
    m.taskCreate.mockRejectedValueOnce(new Error("boom"))
    await createTask(props(step))
    expect(m.logError).toHaveBeenCalledTimes(1)
  })

  test("empty title falls back to a contact-keyed title; assignTo none = no assignee", async () => {
    await createTask(
      props({
        ...step,
        title: "",
        assignTo: "none",
        startInDays: null,
        dueInDays: null,
      }),
    )
    expect(m.taskCreate.mock.calls[0][0].data).toMatchObject({
      title: "Task for contact-1",
      assigneeId: null,
      startAt: null,
      dueAt: null,
    })
  })
})

describe("completeTask step", () => {
  const step = {
    id: "s2",
    stepType: "completeTask",
    pipelineId: "pipe-1",
    match: "template",
    templateId: "tpl-1",
    title: "",
  }
  const task = (over: Record<string, unknown>) => ({
    id: "t",
    status: "open",
    templateId: null,
    title: "",
    blockedBy: [],
    ...over,
  })

  test("completes every open unblocked template match, skips blocked ones", async () => {
    m.taskList.mockResolvedValue([
      task({ id: "t1", templateId: "tpl-1" }),
      task({ id: "t2", templateId: "tpl-1", blockedBy: ["t9"] }),
      task({ id: "t3", templateId: "tpl-1", status: "done" }),
      task({ id: "t4", templateId: "other" }),
    ])
    await completeTask(props(step))
    expect(m.taskComplete.mock.calls.map((c) => c[0].taskId)).toEqual(["t1"])
    expect(m.logInfo).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "t2" }),
      expect.stringContaining("blocked"),
    )
  })

  test("title match is exact and case-insensitive", async () => {
    m.taskList.mockResolvedValue([
      task({ id: "t1", title: "Call Back " }),
      task({ id: "t2", title: "Call back now" }),
    ])
    await completeTask(
      props({
        ...step,
        match: "title",
        title: "call back",
        templateId: undefined,
      }),
    )
    expect(m.taskComplete.mock.calls.map((c) => c[0].taskId)).toEqual(["t1"])
  })

  test("no match -> skipped log, nothing completed; missing target -> warn", async () => {
    m.taskList.mockResolvedValue([])
    await completeTask(props(step))
    expect(m.taskComplete).not.toHaveBeenCalled()
    await completeTask(props({ ...step, templateId: undefined }))
    expect(m.logWarn).toHaveBeenCalledTimes(1)
  })
})
