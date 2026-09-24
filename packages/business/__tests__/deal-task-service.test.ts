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
  dealTaskTemplateModel: { _name: "DealTaskTemplate" },
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
  dealService: { findOrFail: (...a: unknown[]) => m.dealFindOrFail(...a) },
}))
vi.mock("../src/pipeline/service", () => ({
  pipelineService: {
    resolveStage: (...a: unknown[]) => m.resolveStage(...a),
    findOrFail: (...a: unknown[]) => m.pipelineFindOrFail(...a),
  },
}))
vi.mock("../src/audit/dispatcher", () => ({ dispatchAuditRecord: vi.fn() }))
vi.mock("../src/logger", () => ({ logger: { warn: m.logWarn, info: vi.fn() } }))

const { dealTaskService, DEPENDENCY_WALK_STEP_CAP } = await import(
  "../src/deal-task/service"
)

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
  dueAt: null,
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
          dueInDays: 2,
          assignToOwner: true,
          assigneeId: null,
        },
        {
          id: "tpl-2",
          title: "Send quote",
          description: null,
          dueInDays: null,
          assignToOwner: false,
          assigneeId: "user-9",
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
