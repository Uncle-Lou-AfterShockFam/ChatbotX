import { beforeEach, describe, expect, test, vi } from "vitest"

/**
 * Queue-driven mock at the query-builder seam: every SELECT pops the next
 * result from `state.selects`, every INSERT records its values and returns
 * them, every UPDATE pops `state.updates` (empty array = 0 rows), every
 * DELETE pops `state.deletes`, `execute` pops `state.executes`.
 */
const m = vi.hoisted(() => {
  const state = {
    selects: [] as unknown[][],
    updates: [] as unknown[][],
    deletes: [] as unknown[][],
    executes: [] as { rows: unknown[] }[],
    inserted: [] as Record<string, unknown>[],
    insertConflict: false,
    /** A task insert with this title rejects (an FK violation stand-in). */
    insertFailTitle: null as string | null,
    activities: [] as Record<string, unknown>[],
    calls: [] as string[],
  }
  const chain = (kind: "select" | "update" | "delete") => {
    const self: Record<string, unknown> = {}
    const queues = {
      select: state.selects,
      update: state.updates,
      delete: state.deletes,
    }
    const resolve = () => {
      const queue = queues[kind]
      const next = queue.shift()
      if (next === undefined) {
        throw new Error(
          `mock: no ${kind} result queued (calls: ${state.calls.join(",")})`,
        )
      }
      return Promise.resolve(next)
    }
    for (const k of [
      "from",
      "where",
      "orderBy",
      "limit",
      "innerJoin",
      "set",
      "returning",
      "for",
    ]) {
      self[k] = (v: unknown) => {
        if (k === "set") {
          state.calls.push(`update:${Object.keys(v as object).join(",")}`)
        }
        if (k === "for") {
          state.calls.push(`for:${String(v)}`)
        }
        return self
      }
    }
    // biome-ignore lint/suspicious/noThenProperty: the mock must be awaitable like a drizzle query
    self.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
      resolve().then(ok, ko)
    return self
  }
  const makeTx = () => ({
    select: () => {
      state.calls.push("select")
      return chain("select")
    },
    update: () => {
      state.calls.push("update")
      return chain("update")
    },
    delete: () => {
      state.calls.push("delete")
      return chain("delete")
    },
    insert: (model: { _name: string }) => ({
      values: (v: Record<string, unknown>) => {
        const row = { ...v, createdAt: new Date(), updatedAt: new Date() }
        const done = {
          returning: () => {
            if (model._name === "DealActivity") {
              state.activities.push(row)
              state.calls.push(`activity:${String(v.type)}`)
              return Promise.resolve([row])
            }
            state.calls.push(`insert:${model._name}`)
            if (state.insertFailTitle && v.title === state.insertFailTitle) {
              return Promise.reject(new Error("fk violation"))
            }
            if (state.insertConflict) {
              return Promise.resolve([])
            }
            state.inserted.push(row)
            return Promise.resolve([row])
          },
          onConflictDoNothing: () => done,
          // biome-ignore lint/suspicious/noThenProperty: awaitable like a drizzle insert
          then: (ok: (v: unknown) => unknown) => {
            if (model._name === "DealActivity") {
              state.activities.push(row)
              state.calls.push(`activity:${String(v.type)}`)
            }
            return Promise.resolve(undefined).then(ok)
          },
        }
        return done
      },
    }),
    execute: () => {
      state.calls.push("execute")
      const next = state.executes.shift()
      return Promise.resolve(next ?? { rows: [] })
    },
    transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      await fn(makeTx()),
  })
  return {
    state,
    makeTx,
    dealFindOrFail: vi.fn(),
    dealList: vi.fn(),
    resolveStage: vi.fn(),
    pipelineFindOrFail: vi.fn(),
    emitCreated: vi.fn(() => {
      state.calls.push("emit:taskCreated")
      return Promise.resolve()
    }),
    emitCompleted: vi.fn(() => {
      state.calls.push("emit:taskCompleted")
      return Promise.resolve()
    }),
    emitOverdue: vi.fn(() => {
      state.calls.push("emit:taskOverdue")
      return Promise.resolve()
    }),
    emitAssigned: vi.fn(() => {
      state.calls.push("emit:taskAssigned")
      return Promise.resolve()
    }),
    logWarn: vi.fn(),
  }
})

vi.mock("@chatbotx.io/database/client", () => ({
  db: m.makeTx(),
  and: vi.fn((...c: unknown[]) => ({ c })),
  eq: vi.fn((f: unknown, v: unknown) => ({ f, v })),
  inArray: vi.fn((f: unknown, v: unknown) => ({ f, v })),
  sql: Object.assign(
    vi.fn((s: TemplateStringsArray, ...v: unknown[]) => ({ s, v })),
    {},
  ),
}))
vi.mock("@chatbotx.io/database/schema", () => ({
  dealActivityModel: { _name: "DealActivity" },
  dealDependencyModel: {
    _name: "DealDependency",
    taskId: "taskId",
    dependsOnTaskId: "dependsOnTaskId",
    workspaceId: "ws",
    id: "id",
  },
  dealTaskModel: {
    _name: "DealTask",
    id: "id",
    dealId: "dealId",
    status: "status",
    workspaceId: "ws",
    assigneeId: "assigneeId",
    createdAt: "createdAt",
    dueAt: "dueAt",
    templateId: "templateId",
  },
  dealTaskTemplateModel: {
    _name: "DealTaskTemplate",
    id: "id",
    stageId: "stageId",
    workspaceId: "ws",
    pipelineId: "pipelineId",
  },
  dealTaskTemplateDependencyModel: {
    _name: "DealTaskTemplateDependency",
    id: "id",
    templateId: "templateId",
    dependsOnTemplateId: "dependsOnTemplateId",
    workspaceId: "ws",
  },
  workspaceMemberModel: { workspaceId: "ws", userId: "userId" },
}))
vi.mock("@chatbotx.io/utils", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createId: (() => {
    let n = 0
    return () => `id-${++n}`
  })(),
}))
vi.mock("@chatbotx.io/events", () => ({
  emitDealTaskCreated: (...a: unknown[]) => m.emitCreated(...a),
  emitDealTaskCompleted: (...a: unknown[]) => m.emitCompleted(...a),
  emitDealTaskOverdue: (...a: unknown[]) => m.emitOverdue(...a),
  emitDealTaskAssigned: (...a: unknown[]) => m.emitAssigned(...a),
}))
vi.mock("../src/deal/service", () => ({
  dealService: {
    findOrFail: (...a: unknown[]) => m.dealFindOrFail(...a),
    list: (...a: unknown[]) => m.dealList(...a),
  },
}))
vi.mock("../src/pipeline/service", () => ({
  pipelineService: {
    resolveStage: (...a: unknown[]) => m.resolveStage(...a),
    findOrFail: (...a: unknown[]) => m.pipelineFindOrFail(...a),
  },
}))
vi.mock("../src/audit/dispatcher", () => ({ dispatchAuditRecord: vi.fn() }))
const logInfo = vi.fn()
vi.mock("../src/logger", () => ({
  logger: { warn: m.logWarn, info: (...a: unknown[]) => logInfo(...a) },
}))
// s194: the assignee's own notification, recorded apart from `calls` so the
// tx-order assertions above stay exact
const notify = vi.fn(async () => ({ notification: null, pushEnqueued: false }))
vi.mock("../src/notification/service", () => ({
  notificationService: { notify: (...a: unknown[]) => notify(...a) },
}))

const { dealTaskService, DEPENDENCY_WALK_STEP_CAP } = await import(
  "../src/deal-task/service"
)
const { dealTaskTemplateService } = await import("../src/deal-task/templates")
const { withSchedule, downstreamOpen } = await import(
  "../src/deal-task/schedule"
)
const { createId } = await import("@chatbotx.io/utils")
/**
 * The ids the next instantiation of two templates will mint: each template
 * takes one id for its task and one for its activity row.
 */
const nextTwoTaskIds = (): [string, string] => {
  const n = Number(createId().split("-")[1])
  return [`id-${n + 1}`, `id-${n + 3}`]
}

const WS = "ws-1"
const DEAL = {
  id: "deal-1",
  workspaceId: WS,
  pipelineId: "pipe-1",
  stageId: "stage-1",
  title: "Roof",
  value: null,
  currency: "USD",
  status: "open",
  priority: "medium",
  contactId: "contact-1",
  companyId: null,
  ownerId: "owner-1",
}
const TASK = (over: Record<string, unknown> = {}) => ({
  id: "task-1",
  workspaceId: WS,
  dealId: "deal-1",
  title: "Call back",
  description: null,
  status: "open",
  startAt: null,
  dueAt: null,
  createdAt: new Date("2026-09-01T00:00:00Z"),
  completedAt: null,
  overdueNotifiedAt: null,
  templateId: null,
  assigneeId: null,
  createdById: null,
  completedById: null,
  ...over,
})
const MEMBER = [{ userId: "user-9" }]

beforeEach(() => {
  vi.clearAllMocks()
  for (const k of [
    "selects",
    "updates",
    "deletes",
    "executes",
    "inserted",
    "activities",
    "calls",
  ] as const) {
    ;(m.state[k] as unknown[]).length = 0
  }
  m.state.insertConflict = false
  m.state.insertFailTitle = null
  m.dealFindOrFail.mockResolvedValue({ ...DEAL })
})

describe("dealTaskService.create", () => {
  test("row + taskCreated activity in the tx, then the event; an assignee adds taskAssigned", async () => {
    m.state.selects.push([{ count: 0 }], MEMBER)
    const task = await dealTaskService.create({
      workspaceId: WS,
      dealId: "deal-1",
      data: { title: " Call back ", assigneeId: "user-9", dueAt: "2026-10-01" },
      actorId: "actor-1",
    })
    expect(task.title).toBe("Call back")
    expect(task.assigneeId).toBe("user-9")
    expect(m.state.calls.filter((c) => !c.startsWith("select"))).toEqual([
      "insert:DealTask",
      "activity:taskCreated",
      "emit:taskCreated",
      "emit:taskAssigned",
    ])
    const [, contactId, meta] = m.emitCreated.mock.calls[0] as unknown[]
    expect(contactId).toBe("contact-1")
    expect(meta).toMatchObject({
      dealId: "deal-1",
      pipelineId: "pipe-1",
      taskTitle: "Call back",
    })
  })

  test("the 200-tasks cap is a 422 before any insert", async () => {
    m.state.selects.push([{ count: 200 }])
    await expect(
      dealTaskService.create({
        workspaceId: WS,
        dealId: "deal-1",
        data: { title: "x" },
      }),
    ).rejects.toThrow("at most 200 tasks")
    expect(m.state.inserted).toEqual([])
  })

  test.each([
    [null, "Task data is required"],
    [{ title: "" }, "Title is required"],
    [{ title: "x".repeat(201) }, "at most 200"],
    [{ title: "ok", description: "d".repeat(2001) }, "at most 2000"],
    [{ title: "ok", dueAt: "never" }, "valid date"],
    [{ title: "ok", description: 5 }, "must be text"],
  ])("data %j -> 422 %s", async (data, message) => {
    await expect(
      dealTaskService.create({
        workspaceId: WS,
        dealId: "deal-1",
        data: data as never,
      }),
    ).rejects.toThrow(message)
  })

  test("a non-member assignee is a 422", async () => {
    m.state.selects.push([{ count: 0 }], [])
    await expect(
      dealTaskService.create({
        workspaceId: WS,
        dealId: "deal-1",
        data: { title: "x", assigneeId: "ghost" },
      }),
    ).rejects.toThrow("not a member")
  })

  test("no contact on the deal = no event, the write still happens", async () => {
    m.dealFindOrFail.mockResolvedValue({ ...DEAL, contactId: null })
    m.state.selects.push([{ count: 0 }])
    await dealTaskService.create({
      workspaceId: WS,
      dealId: "deal-1",
      data: { title: "x" },
    })
    expect(m.state.inserted).toHaveLength(1)
    expect(m.emitCreated).not.toHaveBeenCalled()
  })

  test("s194: the assignee is notified after the emit, even on a contact-less deal", async () => {
    m.dealFindOrFail.mockResolvedValue({ ...DEAL, contactId: null })
    m.state.selects.push([{ count: 0 }], MEMBER)
    await dealTaskService.create({
      workspaceId: WS,
      dealId: "deal-1",
      data: { title: "Call back", assigneeId: "user-9" },
      actorId: "actor-1",
    })
    expect(m.emitAssigned).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith({
      workspaceId: WS,
      userId: "user-9",
      type: "taskAssigned",
      dealId: "deal-1",
      taskId: expect.any(String),
      payload: {
        pipelineId: "pipe-1",
        dealTitle: "Roof",
        taskTitle: "Call back",
        actorId: "actor-1",
      },
    })
  })

  test("s194: a concurrent identical reassignment touches 0 rows = no second event, no second notification", async () => {
    // update(): current row -> resolveAssignee member select -> UPDATE pinned
    // to the old assignee returns 0 rows -> re-read the task
    m.state.selects.push([TASK({ assigneeId: null })], MEMBER, [
      TASK({ assigneeId: "user-9" }),
    ])
    m.state.updates.push([])
    const task = await dealTaskService.update({
      workspaceId: WS,
      dealId: "deal-1",
      taskId: "task-1",
      data: { assigneeId: "user-9" },
      actorId: "actor-1",
    })
    expect(task.assigneeId).toBe("user-9")
    expect(m.emitAssigned).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
    expect(m.state.calls.some((c) => c.startsWith("update:assigneeId"))).toBe(
      true,
    )
  })

  test("s194: assigning yourself is silent; a notify failure never fails the create", async () => {
    m.state.selects.push([{ count: 0 }], MEMBER)
    await dealTaskService.create({
      workspaceId: WS,
      dealId: "deal-1",
      data: { title: "x", assigneeId: "user-9" },
      actorId: "user-9",
    })
    expect(notify).not.toHaveBeenCalled()

    notify.mockRejectedValueOnce(new Error("redis down"))
    m.state.selects.push([{ count: 0 }], MEMBER)
    const task = await dealTaskService.create({
      workspaceId: WS,
      dealId: "deal-1",
      data: { title: "x", assigneeId: "user-9" },
      actorId: "actor-1",
    })
    expect(task.assigneeId).toBe("user-9")
    expect(m.logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: task.id }),
      "deal-task: notify failed",
    )
  })
})

describe("dealTaskService.complete", () => {
  test("open + unblocked: blockers read FOR SHARE, status-pinned UPDATE, activity in tx, event after", async () => {
    m.state.selects.push([TASK()], [])
    m.state.updates.push([TASK({ status: "done" })])
    const result = await dealTaskService.complete({
      workspaceId: WS,
      dealId: "deal-1",
      taskId: "task-1",
      actorId: "u1",
    })
    expect(result.completed).toBe(true)
    expect(m.state.calls.filter((c) => !c.startsWith("select"))).toEqual([
      // s197: the deal graph lock before the blocker read (no deadlock with
      // a successor shift, which locks every task of the deal)
      "execute",
      "for:share",
      "update",
      "update:status,completedAt,completedById",
      "activity:taskCompleted",
      "emit:taskCompleted",
    ])
    expect((m.emitCompleted.mock.calls[0] as unknown[])[2]).toMatchObject({
      completedById: "u1",
    })
  })

  test("blocked by an open task -> 422 taskBlocked, nothing written; force bypasses", async () => {
    m.state.selects.push([TASK()], [{ id: "task-0" }])
    await expect(
      dealTaskService.complete({
        workspaceId: WS,
        dealId: "deal-1",
        taskId: "task-1",
      }),
    ).rejects.toThrow("blocked by an open task")
    expect(m.state.activities).toEqual([])
    m.state.selects.push([TASK()])
    m.state.updates.push([TASK({ status: "done" })])
    const forced = await dealTaskService.complete({
      workspaceId: WS,
      dealId: "deal-1",
      taskId: "task-1",
      force: true,
    })
    expect(forced.completed).toBe(true)
  })

  test("already done: returns the row, no activity, no event (idempotent)", async () => {
    m.state.selects.push([TASK({ status: "done" })])
    const result = await dealTaskService.complete({
      workspaceId: WS,
      dealId: "deal-1",
      taskId: "task-1",
    })
    expect(result.completed).toBe(false)
    expect(m.state.activities).toEqual([])
    expect(m.emitCompleted).not.toHaveBeenCalled()
  })

  test("lost the race (UPDATE matched 0 rows): no second activity or event", async () => {
    m.state.selects.push([TASK()], [])
    m.state.updates.push([])
    const result = await dealTaskService.complete({
      workspaceId: WS,
      dealId: "deal-1",
      taskId: "task-1",
    })
    expect(result.completed).toBe(false)
    expect(m.state.activities).toEqual([])
    expect(m.emitCompleted).not.toHaveBeenCalled()
  })

  test("unknown task -> 404", async () => {
    m.state.selects.push([])
    await expect(
      dealTaskService.complete({
        workspaceId: WS,
        dealId: "deal-1",
        taskId: "nope",
      }),
    ).rejects.toThrow("Task not found")
  })
})

describe("dealTaskService.addDependency", () => {
  const deps = (edges: [string, string][]) =>
    edges.map(([taskId, dependsOnTaskId]) => ({ taskId, dependsOnTaskId }))

  test("self -> 422 before any query", async () => {
    await expect(
      dealTaskService.addDependency({
        workspaceId: WS,
        dealId: "deal-1",
        taskId: "a",
        dependsOnTaskId: "a",
      }),
    ).rejects.toThrow("depend on itself")
    expect(m.state.calls).toEqual([])
  })

  test("takes the per-deal advisory lock FIRST, then inserts a clean edge", async () => {
    m.state.selects.push([TASK({ id: "a" })], [TASK({ id: "b" })], deps([]))
    const row = await dealTaskService.addDependency({
      workspaceId: WS,
      dealId: "deal-1",
      taskId: "a",
      dependsOnTaskId: "b",
    })
    expect(m.state.calls[0]).toBe("execute")
    expect(row).toMatchObject({ taskId: "a", dependsOnTaskId: "b" })
  })

  test("A->B->C then C->A is a cycle -> 422", async () => {
    m.state.selects.push(
      [TASK({ id: "c" })],
      [TASK({ id: "a" })],
      deps([
        ["a", "b"],
        ["b", "c"],
      ]),
    )
    await expect(
      dealTaskService.addDependency({
        workspaceId: WS,
        dealId: "deal-1",
        taskId: "c",
        dependsOnTaskId: "a",
      }),
    ).rejects.toThrow("cycle")
    expect(m.state.inserted).toEqual([])
  })

  test("a duplicate edge -> 422; the 20-per-task cap -> 422", async () => {
    m.state.selects.push(
      [TASK({ id: "a" })],
      [TASK({ id: "b" })],
      deps([["a", "b"]]),
    )
    await expect(
      dealTaskService.addDependency({
        workspaceId: WS,
        dealId: "deal-1",
        taskId: "a",
        dependsOnTaskId: "b",
      }),
    ).rejects.toThrow("already exists")
    const many = deps(
      Array.from({ length: 20 }, (_, i) => ["a", `t${i}`] as [string, string]),
    )
    m.state.selects.push([TASK({ id: "a" })], [TASK({ id: "z" })], many)
    await expect(
      dealTaskService.addDependency({
        workspaceId: WS,
        dealId: "deal-1",
        taskId: "a",
        dependsOnTaskId: "z",
      }),
    ).rejects.toThrow("at most 20")
  })

  test("a task of another deal is a 404 (the deal-scoped lookup misses)", async () => {
    m.state.selects.push([TASK({ id: "a" })], [])
    await expect(
      dealTaskService.addDependency({
        workspaceId: WS,
        dealId: "deal-1",
        taskId: "a",
        dependsOnTaskId: "foreign",
      }),
    ).rejects.toThrow("Task not found")
  })

  test("reaches(): a 200-node ring terminates under the visited set; an over-cap fan-out trips the hard stop", () => {
    const ring = deps(
      Array.from(
        { length: 200 },
        (_, i) => [`n${i}`, `n${(i + 1) % 200}`] as [string, string],
      ),
    )
    expect(
      dealTaskService.reaches({ edges: ring, from: "n0", to: "n199" }),
    ).toBe(true)
    expect(
      dealTaskService.reaches({ edges: ring, from: "n0", to: "outside" }),
    ).toBe(false)
    const fan = deps(
      Array.from(
        { length: DEPENDENCY_WALK_STEP_CAP + 1 },
        (_, i) => ["hub", `leaf${i}`] as [string, string],
      ),
    )
    expect(() =>
      dealTaskService.reaches({ edges: fan, from: "hub", to: "nowhere" }),
    ).toThrow("too large")
  })
})

describe("dealTaskService.list", () => {
  test("dependsOn carries every edge, blockedBy only the OPEN blockers (a done blocker's edge stays removable)", async () => {
    m.state.selects.push(
      [TASK({ id: "a" }), TASK({ id: "b", status: "done" }), TASK({ id: "c" })],
      [
        { taskId: "a", dependsOnTaskId: "b" },
        { taskId: "a", dependsOnTaskId: "c" },
      ],
    )
    const rows = await dealTaskService.list({
      workspaceId: WS,
      dealId: "deal-1",
    })
    const a = rows.find((r) => r.id === "a")
    expect(a?.dependsOn).toEqual(["b", "c"])
    expect(a?.blockedBy).toEqual(["c"])
  })
})

describe("dealTaskService.update", () => {
  test("an assignee change emits taskAssigned with the previous assignee", async () => {
    m.state.selects.push([TASK({ assigneeId: "old" })], MEMBER)
    m.state.updates.push([TASK({ assigneeId: "user-9" })])
    await dealTaskService.update({
      workspaceId: WS,
      dealId: "deal-1",
      taskId: "task-1",
      data: { assigneeId: "user-9" },
    })
    expect((m.emitAssigned.mock.calls[0] as unknown[])[2]).toMatchObject({
      previousAssigneeId: "old",
      assigneeId: "user-9",
    })
  })

  test("a due date moved into the future re-arms the overdue scanner", async () => {
    m.state.selects.push([
      TASK({
        dueAt: new Date("2026-01-01"),
        overdueNotifiedAt: new Date("2026-01-02"),
      }),
    ])
    m.state.updates.push([TASK()])
    await dealTaskService.update({
      workspaceId: WS,
      dealId: "deal-1",
      taskId: "task-1",
      data: { dueAt: new Date(Date.now() + 864e5) },
    })
    expect(m.state.calls).toContain("update:dueAt,overdueNotifiedAt")
  })

  test("a no-op patch writes nothing", async () => {
    m.state.selects.push([TASK({ title: "Call back" })])
    await dealTaskService.update({
      workspaceId: WS,
      dealId: "deal-1",
      taskId: "task-1",
      data: { title: "Call back", assigneeId: null },
    })
    expect(m.state.calls.filter((c) => c.startsWith("update"))).toEqual([])
  })
})

describe("dealTaskService.claimOverdue + instantiateForStage", () => {
  test("claims via SKIP LOCKED, stamps, emits once per row; an emit failure is logged and the claim stands", async () => {
    m.state.executes.push({ rows: [{ id: "task-1" }, { id: "task-2" }] })
    m.state.updates.push([
      TASK({ id: "task-1", dueAt: new Date("2026-01-01") }),
      TASK({ id: "task-2" }),
    ])
    m.dealFindOrFail
      .mockResolvedValueOnce({ ...DEAL })
      .mockRejectedValueOnce(new Error("gone"))
    const result = await dealTaskService.claimOverdue({
      now: new Date("2026-09-24T00:00:00Z"),
    })
    expect(result).toEqual({ scanned: 2, emitted: 1 })
    expect(m.emitOverdue).toHaveBeenCalledTimes(1)
    expect(m.logWarn).toHaveBeenCalledTimes(1)
  })

  test("nothing due = no update, no emit", async () => {
    m.state.executes.push({ rows: [] })
    expect(await dealTaskService.claimOverdue()).toEqual({
      scanned: 0,
      emitted: 0,
    })
    expect(m.state.calls).not.toContain("update")
  })

  test("templates: assignToOwner takes the deal's CURRENT owner (re-read, not the caller's snapshot), dueInDays sets dueAt, a conflict row is skipped silently", async () => {
    m.dealFindOrFail.mockResolvedValue({ ...DEAL, ownerId: "owner-1" })
    vi.useFakeTimers({ now: new Date("2026-09-24T00:00:00Z") })
    try {
      const templates = [
        {
          id: "tpl-1",
          title: "Call back",
          description: null,
          startInDays: null,
          dueInDays: 2,
          assignToOwner: true,
          assigneeId: null,
          dependsOn: [],
        },
        {
          id: "tpl-2",
          title: "Send quote",
          description: null,
          startInDays: null,
          dueInDays: null,
          assignToOwner: false,
          assigneeId: "user-9",
          dependsOn: [],
        },
      ]
      const { created } = await dealTaskService.instantiateForStage({
        workspaceId: WS,
        deal: { ...DEAL, ownerId: "stale-owner" } as never,
        stageId: "stage-1",
        actorId: null,
        templates,
      })
      expect(created.map((t) => [t.title, t.assigneeId, t.dueAt])).toEqual([
        ["Call back", "owner-1", new Date("2026-09-26T00:00:00Z")],
        ["Send quote", "user-9", null],
      ])
      expect(m.state.activities).toHaveLength(2)
      expect(m.emitCreated).toHaveBeenCalledTimes(2)
      expect(m.emitAssigned).toHaveBeenCalledTimes(2)
      m.state.insertConflict = true
      const again = await dealTaskService.instantiateForStage({
        workspaceId: WS,
        deal: DEAL as never,
        stageId: "stage-1",
        actorId: null,
        templates,
      })
      expect(again.created).toEqual([])
      expect(m.state.activities).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("dealTaskService.listByDealIds (s195)", () => {
  test("empty input = no query; only the viewer-visible deals are consulted; the page is capped", async () => {
    const listSpy = m.dealList.mockResolvedValue({
      data: [{ id: "d-1" }],
      pageCount: 1,
    })
    expect(
      await dealTaskService.listByDealIds({ workspaceId: "ws-1", dealIds: [] }),
    ).toEqual([])
    expect(listSpy).not.toHaveBeenCalled()

    m.state.selects.push([{ id: "t-1", dealId: "d-1" }])
    const rows = await dealTaskService.listByDealIds({
      workspaceId: "ws-1",
      dealIds: ["d-1", "d-hidden"],
      viewer: { userId: "u-1", permissions: {} },
      limit: 9999,
    })
    expect(rows).toEqual([{ id: "t-1", dealId: "d-1" }])
    expect(listSpy).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-1", perPage: 2 }),
    )
    listSpy.mockResolvedValueOnce({ data: [], pageCount: 1 })
    expect(
      await dealTaskService.listByDealIds({
        workspaceId: "ws-1",
        dealIds: ["d-hidden"],
        viewer: { userId: "u-1", permissions: {} },
      }),
    ).toEqual([])
  })
})

// ---- s197: timeline (startAt), successor shift, template dependencies ----

const D = (iso: string) => new Date(`${iso}T00:00:00Z`)

describe("s197 withSchedule (effectiveStart + conflicts)", () => {
  test("start = startAt, else the latest predecessor due (never after its own due), else createdAt", () => {
    const rows = withSchedule(
      [
        TASK({ id: "p1", dueAt: D("2026-10-05") }),
        TASK({ id: "p2", dueAt: D("2026-10-08"), status: "done" }),
        TASK({ id: "own", startAt: D("2026-10-02"), dueAt: D("2026-10-09") }),
        TASK({ id: "derived", dueAt: D("2026-10-20") }),
        TASK({ id: "clamped", dueAt: D("2026-10-06") }),
        TASK({ id: "lonely" }),
      ] as never[],
      [
        { taskId: "own", dependsOnTaskId: "p1" },
        { taskId: "derived", dependsOnTaskId: "p1" },
        { taskId: "derived", dependsOnTaskId: "p2" },
        { taskId: "clamped", dependsOnTaskId: "p2" },
      ],
    )
    const by = new Map(rows.map((r) => [r.id, r]))
    expect(by.get("own")?.effectiveStart).toEqual(D("2026-10-02"))
    // a DONE predecessor's due date still places the bar
    expect(by.get("derived")?.effectiveStart).toEqual(D("2026-10-08"))
    expect(by.get("clamped")?.effectiveStart).toEqual(D("2026-10-06"))
    expect(by.get("lonely")?.effectiveStart).toEqual(D("2026-09-01"))
    expect(by.get("derived")?.blockedBy).toEqual(["p1"])
  })

  test("conflicts = OPEN predecessors due after the task's own start (or due); a done task or a done predecessor has none", () => {
    const rows = withSchedule(
      [
        TASK({ id: "p", dueAt: D("2026-10-10") }),
        TASK({ id: "q", dueAt: D("2026-10-12"), status: "done" }),
        TASK({ id: "early", startAt: D("2026-10-03"), dueAt: D("2026-10-15") }),
        TASK({ id: "dueFirst", dueAt: D("2026-10-04") }),
        TASK({ id: "fine", startAt: D("2026-10-11"), dueAt: D("2026-10-13") }),
        TASK({ id: "finished", startAt: D("2026-10-01"), status: "done" }),
        TASK({ id: "undated" }),
      ] as never[],
      ["early", "dueFirst", "fine", "finished", "undated"].flatMap((id) => [
        { taskId: id, dependsOnTaskId: "p" },
        { taskId: id, dependsOnTaskId: "q" },
      ]),
    )
    const by = new Map(rows.map((r) => [r.id, r.conflicts]))
    expect(by.get("early")).toEqual(["p"])
    expect(by.get("dueFirst")).toEqual(["p"])
    expect(by.get("fine")).toEqual([])
    expect(by.get("finished")).toEqual([])
    expect(by.get("undated")).toEqual([])
  })
})

describe("s197 downstreamOpen", () => {
  test("a diamond is walked once, a done task is neither returned nor walked through", () => {
    const tasks = ["a", "b", "c", "d", "e", "f"].map((id) => ({
      id,
      status: id === "e" ? "done" : "open",
    }))
    const edges = [
      { taskId: "b", dependsOnTaskId: "a" },
      { taskId: "c", dependsOnTaskId: "a" },
      { taskId: "d", dependsOnTaskId: "b" },
      { taskId: "d", dependsOnTaskId: "c" },
      { taskId: "e", dependsOnTaskId: "a" },
      { taskId: "f", dependsOnTaskId: "e" },
    ]
    expect(downstreamOpen({ tasks, edges, from: "a" })).toEqual(["b", "c", "d"])
    expect(downstreamOpen({ tasks, edges, from: "d" })).toEqual([])
  })

  test("a 200-task chain is walked end to end; a fan past the step cap throws a typed 422", () => {
    const chain = Array.from({ length: 200 }, (_, i) => ({
      id: `t${i}`,
      status: "open",
    }))
    const chainEdges = chain
      .slice(1)
      .map((t, i) => ({ taskId: t.id, dependsOnTaskId: `t${i}` }))
    expect(
      downstreamOpen({ tasks: chain, edges: chainEdges, from: "t0" }),
    ).toHaveLength(199)
    const fan = Array.from(
      { length: DEPENDENCY_WALK_STEP_CAP + 1 },
      (_, i) => ({
        taskId: `x${i}`,
        dependsOnTaskId: "hub",
      }),
    )
    expect(() =>
      downstreamOpen({ tasks: [], edges: fan, from: "hub" }),
    ).toThrow("too large")
  })
})

describe("s197 dealTaskService.create / update dates", () => {
  test("create refuses a start after the due date before any transaction (422 startAfterDue)", async () => {
    await expect(
      dealTaskService.create({
        workspaceId: WS,
        dealId: "deal-1",
        data: {
          title: "x",
          startAt: D("2026-10-05"),
          dueAt: D("2026-10-04"),
        },
      }),
    ).rejects.toMatchObject({ data: { reason: "startAfterDue" } })
    expect(m.state.calls).toEqual([])
  })

  test("update checks the MERGED dates: a start past the stored due date is refused, nothing written", async () => {
    m.state.selects.push([TASK({ dueAt: D("2026-10-04") })])
    await expect(
      dealTaskService.update({
        workspaceId: WS,
        dealId: "deal-1",
        taskId: "task-1",
        data: { startAt: D("2026-10-05") },
      }),
    ).rejects.toMatchObject({ data: { reason: "startAfterDue" } })
    expect(m.state.calls).not.toContain("update")
  })

  test("shiftSuccessors: lock BEFORE the row write, then every open downstream task moves by the same delta (start and due), done ones stay", async () => {
    const edges = [
      { taskId: "b", dependsOnTaskId: "task-1" },
      { taskId: "c", dependsOnTaskId: "task-1" },
      { taskId: "d", dependsOnTaskId: "b" },
      { taskId: "d", dependsOnTaskId: "c" },
      { taskId: "e", dependsOnTaskId: "task-1" },
    ]
    m.state.selects.push(
      [TASK({ dueAt: D("2026-10-01") })],
      [
        { id: "task-1", status: "open", startAt: null, dueAt: D("2026-10-03") },
        {
          id: "b",
          status: "open",
          startAt: D("2026-10-02"),
          dueAt: D("2026-10-05"),
        },
        { id: "c", status: "open", startAt: null, dueAt: D("2026-10-06") },
        { id: "d", status: "open", startAt: null, dueAt: null },
        { id: "e", status: "done", startAt: null, dueAt: D("2026-10-02") },
      ],
      edges,
    )
    m.state.updates.push([TASK({ dueAt: D("2026-10-03") })], [], [])
    const result = await dealTaskService.update({
      workspaceId: WS,
      dealId: "deal-1",
      taskId: "task-1",
      data: { dueAt: D("2026-10-03"), shiftSuccessors: true },
    })
    expect(result.shifted).toEqual(["b", "c"])
    const calls = m.state.calls
    expect(calls.indexOf("execute")).toBeGreaterThan(-1)
    expect(calls.indexOf("execute")).toBeLessThan(
      calls.indexOf("update:dueAt,overdueNotifiedAt"),
    )
    expect(calls).toContain("for:update")
    // b and c moved (+2 days); d has no dates; e is done
    expect(calls.filter((c) => c.startsWith("update:startAt"))).toHaveLength(2)
  })

  test("without shiftSuccessors (or with no due-date move) there is no graph lock and no walk; a date change still reads its row FOR UPDATE", async () => {
    m.state.selects.push([TASK({ dueAt: D("2026-10-01") })])
    m.state.updates.push([TASK({ dueAt: D("2026-10-03") })])
    const plain = await dealTaskService.update({
      workspaceId: WS,
      dealId: "deal-1",
      taskId: "task-1",
      data: { dueAt: D("2026-10-03") },
    })
    expect(plain.shifted).toEqual([])
    // the date change validated against a LOCKED row (codex probe, s197)
    expect(m.state.calls.filter((c) => c === "for:update")).toHaveLength(1)
    m.state.calls.length = 0
    m.state.selects.push([TASK({ dueAt: D("2026-10-01") })])
    m.state.updates.push([TASK({ title: "renamed" })])
    await dealTaskService.update({
      workspaceId: WS,
      dealId: "deal-1",
      taskId: "task-1",
      data: { title: "renamed", shiftSuccessors: true },
    })
    expect(m.state.calls).not.toContain("execute")
    expect(m.state.calls).not.toContain("for:update")
  })

  test("shiftSuccessors takes the graph lock BEFORE the source row is read (the delta comes from the locked row)", async () => {
    m.state.selects.push([TASK({ dueAt: D("2026-10-01") })], [], [])
    m.state.updates.push([TASK({ dueAt: D("2026-10-02") })])
    await dealTaskService.update({
      workspaceId: WS,
      dealId: "deal-1",
      taskId: "task-1",
      data: { dueAt: D("2026-10-02"), shiftSuccessors: true },
    })
    expect(m.state.calls.slice(0, 3)).toEqual([
      "execute",
      "select",
      "for:update",
    ])
  })
})

describe("s197 instantiateForStage copies template edges", () => {
  const TPL = (over: Record<string, unknown>) => ({
    id: "tpl",
    title: "T",
    description: null,
    startInDays: null,
    dueInDays: null,
    assignToOwner: false,
    assigneeId: null,
    dependsOn: [] as string[],
    ...over,
  })

  test("startInDays sets startAt; each template edge becomes a DealDependency between the new instances, under the deal lock", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-24T00:00:00Z") })
    try {
      const [a, b] = nextTwoTaskIds()
      // the copy transaction: instances, then the deal's existing edges
      m.state.selects.push(
        [
          { id: a, templateId: "tpl-a" },
          { id: b, templateId: "tpl-b" },
        ],
        [],
      )
      const { created, edges } = await dealTaskService.instantiateForStage({
        workspaceId: WS,
        deal: DEAL as never,
        stageId: "stage-1",
        actorId: null,
        templates: [
          TPL({ id: "tpl-a", startInDays: 1, dueInDays: 3 }),
          TPL({ id: "tpl-b", dueInDays: 5, dependsOn: ["tpl-a"] }),
        ],
      })
      expect(created[0].startAt).toEqual(new Date("2026-09-25T00:00:00Z"))
      expect(created[1].startAt).toBeNull()
      expect(edges).toBe(1)
      const dep = m.state.inserted.filter((r) => "dependsOnTaskId" in r)
      expect(dep).toMatchObject([
        { taskId: created[1].id, dependsOnTaskId: created[0].id },
      ])
      expect(m.state.calls.indexOf("execute")).toBeLessThan(
        m.state.calls.indexOf("insert:DealDependency"),
      )
    } finally {
      vi.useRealTimers()
    }
  })

  test("a template whose insert fails (deleted since the snapshot) is skipped; the others and their edges still land", async () => {
    const [a, c] = nextTwoTaskIds()
    m.state.insertFailTitle = "gone"
    m.state.selects.push(
      [
        { id: a, templateId: "tpl-a", status: "open" },
        { id: c, templateId: "tpl-c", status: "open" },
      ],
      [],
    )
    const { created, edges } = await dealTaskService.instantiateForStage({
      workspaceId: WS,
      deal: DEAL as never,
      stageId: "stage-1",
      actorId: null,
      templates: [
        TPL({ id: "tpl-a", title: "a" }),
        TPL({ id: "tpl-b", title: "gone" }),
        TPL({ id: "tpl-c", title: "c", dependsOn: ["tpl-a", "tpl-b"] }),
      ],
    })
    expect(created.map((t) => t.title)).toEqual(["a", "c"])
    expect(edges).toBe(1)
    expect(m.logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ templateId: "tpl-b" }),
      expect.any(String),
    )
  })

  test("a DONE dependent from an earlier entry gains no blocker", async () => {
    const [a] = nextTwoTaskIds()
    m.state.selects.push(
      [
        { id: a, templateId: "tpl-a", status: "open" },
        { id: "old-b", templateId: "tpl-b", status: "done" },
      ],
      [],
    )
    // tpl-b's instance from an earlier entry is the one the lookup finds
    const { edges } = await dealTaskService.instantiateForStage({
      workspaceId: WS,
      deal: DEAL as never,
      stageId: "stage-1",
      actorId: null,
      templates: [
        TPL({ id: "tpl-a", title: "a" }),
        TPL({ id: "tpl-b", title: "b", dependsOn: ["tpl-a"] }),
      ],
    })
    expect(edges).toBe(0)
    expect(m.state.inserted.filter((r) => "dependsOnTaskId" in r)).toEqual([])
  })

  test("a re-entry that creates nothing copies nothing (an edge removed by hand stays removed)", async () => {
    m.state.insertConflict = true
    const { edges } = await dealTaskService.instantiateForStage({
      workspaceId: WS,
      deal: DEAL as never,
      stageId: "stage-1",
      actorId: null,
      templates: [
        TPL({ id: "tpl-a" }),
        TPL({ id: "tpl-b", dependsOn: ["tpl-a"] }),
      ],
    })
    expect(edges).toBe(0)
    expect(m.state.calls).not.toContain("execute")
  })

  test("an edge that would close a cycle with a hand-made edge is skipped and logged, never thrown", async () => {
    const [a, b] = nextTwoTaskIds()
    m.state.selects.push(
      [
        { id: a, templateId: "tpl-a" },
        { id: b, templateId: "tpl-b" },
      ],
      // by hand, A's task already waits on B's: the template edge B -> A
      // would close the loop
      [{ taskId: a, dependsOnTaskId: b }],
    )
    const { edges } = await dealTaskService.instantiateForStage({
      workspaceId: WS,
      deal: DEAL as never,
      stageId: "stage-1",
      actorId: null,
      templates: [
        TPL({ id: "tpl-a" }),
        TPL({ id: "tpl-b", dependsOn: ["tpl-a"] }),
      ],
    })
    expect(edges).toBe(0)
    expect(logInfo).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "dependencyCycle" }),
      expect.any(String),
    )
  })
})

describe("s197 dealTaskTemplateService dependencies", () => {
  const add = (over: Record<string, unknown> = {}) =>
    dealTaskTemplateService.addDependency({
      workspaceId: WS,
      pipelineId: "pipe-1",
      stageId: "stage-1",
      templateId: "tpl-a",
      dependsOnTemplateId: "tpl-b",
      ...over,
    })
  const BOTH = [
    { id: "tpl-a", stageId: "stage-1" },
    { id: "tpl-b", stageId: "stage-1" },
  ]

  test("self = 422 before any transaction", async () => {
    await expect(add({ dependsOnTemplateId: "tpl-a" })).rejects.toMatchObject({
      data: { reason: "dependencySelf" },
    })
    expect(m.state.calls).toEqual([])
  })

  test("the other template on another stage = 422 dependencyCrossStage; an unknown or foreign-stage own template = 404", async () => {
    m.state.selects.push([
      { id: "tpl-a", stageId: "stage-1" },
      { id: "tpl-b", stageId: "stage-2" },
    ])
    await expect(add()).rejects.toMatchObject({
      data: { reason: "dependencyCrossStage" },
    })
    m.state.selects.push([{ id: "tpl-b", stageId: "stage-1" }])
    await expect(add()).rejects.toThrow("Task template not found")
    m.state.selects.push([
      { id: "tpl-a", stageId: "stage-9" },
      { id: "tpl-b", stageId: "stage-1" },
    ])
    await expect(add()).rejects.toThrow("Task template not found")
  })

  test("duplicate, cycle and fan-in cap are refused; the stage lock comes first", async () => {
    m.state.selects.push(BOTH, [
      { templateId: "tpl-a", dependsOnTemplateId: "tpl-b" },
    ])
    await expect(add()).rejects.toMatchObject({
      data: { reason: "dependencyExists" },
    })
    expect(m.state.calls[0]).toBe("execute")
    m.state.selects.push(BOTH, [
      { templateId: "tpl-b", dependsOnTemplateId: "tpl-c" },
      { templateId: "tpl-c", dependsOnTemplateId: "tpl-a" },
    ])
    await expect(add()).rejects.toMatchObject({
      data: { reason: "dependencyCycle" },
    })
    m.state.selects.push(
      BOTH,
      Array.from({ length: 20 }, (_, i) => ({
        templateId: "tpl-a",
        dependsOnTemplateId: `other-${i}`,
      })),
    )
    await expect(add()).rejects.toMatchObject({
      data: { reason: "tooManyDependencies" },
    })
    expect(m.state.inserted).toEqual([])
  })

  test("happy path inserts one edge", async () => {
    m.state.selects.push(BOTH, [])
    const row = await add()
    expect(row).toMatchObject({
      templateId: "tpl-a",
      dependsOnTemplateId: "tpl-b",
      workspaceId: WS,
    })
  })

  test("upsert refuses startInDays after dueInDays and a non-integer offset", async () => {
    await expect(
      dealTaskTemplateService.upsert({
        workspaceId: WS,
        pipelineId: "pipe-1",
        stageId: "stage-1",
        data: { title: "x", startInDays: 5, dueInDays: 2 },
      }),
    ).rejects.toMatchObject({ data: { reason: "startAfterDue" } })
    await expect(
      dealTaskTemplateService.upsert({
        workspaceId: WS,
        pipelineId: "pipe-1",
        stageId: "stage-1",
        data: { title: "x", startInDays: 1.5 },
      }),
    ).rejects.toThrow("startInDays must be an integer")
  })
})
