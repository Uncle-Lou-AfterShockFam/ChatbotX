import { beforeEach, describe, expect, test, vi } from "vitest"

/**
 * notificationService (s194): the member preference gate, the in-app row,
 * the push job and the realtime send, at the query-builder seam.
 */
const m = vi.hoisted(() => {
  const state = {
    member: undefined as Record<string, unknown> | undefined,
    insertReturns: [] as Record<string, unknown>[],
    updateReturns: [] as Record<string, unknown>[][],
    selectReturns: [] as unknown[][],
    calls: [] as string[],
    inserted: [] as Record<string, unknown>[],
    pipelineAccess: "workspace" as "workspace" | "members",
    pipelineMembers: [] as string[],
  }
  const insertChain = () => {
    const self: Record<string, unknown> = {}
    self.values = (v: Record<string, unknown>) => {
      state.inserted.push(v)
      state.calls.push("insert:Notification")
      return self
    }
    self.onConflictDoNothing = () => {
      state.calls.push("onConflictDoNothing")
      return self
    }
    self.returning = () => Promise.resolve(state.insertReturns.splice(0, 1))
    return self
  }
  const updateChain = (table: { _name: string }) => {
    const self: Record<string, unknown> = {}
    self.set = () => {
      state.calls.push(`update:${table._name}`)
      return self
    }
    self.where = () => self
    self.returning = () => Promise.resolve(state.updateReturns.shift() ?? [])
    // biome-ignore lint/suspicious/noThenProperty: awaitable like a drizzle update
    self.then = (ok: (v: unknown) => unknown) =>
      Promise.resolve(state.updateReturns.shift() ?? []).then(ok)
    return self
  }
  const selectChain = () => {
    const self: Record<string, unknown> = {}
    for (const k of ["from", "where", "orderBy", "limit"]) {
      self[k] = () => self
    }
    // biome-ignore lint/suspicious/noThenProperty: awaitable like a drizzle select
    self.then = (ok: (v: unknown) => unknown) =>
      Promise.resolve(state.selectReturns.shift() ?? []).then(ok)
    return self
  }
  const db = {
    insert: () => insertChain(),
    update: (t: { _name: string }) => updateChain(t),
    select: () => selectChain(),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => await fn(db),
  }
  return {
    state,
    db,
    queueAdd: vi.fn(async () => undefined),
    sendToMember: vi.fn(async () => null),
    logWarn: vi.fn(),
    logInfo: vi.fn(),
  }
})

vi.mock("@chatbotx.io/database/client", () => ({
  db: m.db,
  and: vi.fn((...c: unknown[]) => ({ c })),
  eq: vi.fn((f: unknown, v: unknown) => ({ f, v })),
  desc: vi.fn((f: unknown) => f),
  inArray: vi.fn((f: unknown, v: unknown) => ({ f, v })),
  isNull: vi.fn((f: unknown) => ({ isNull: f })),
  sql: Object.assign(
    vi.fn((s: TemplateStringsArray, ...v: unknown[]) => ({ s, v })),
    {},
  ),
}))
vi.mock("@chatbotx.io/database/schema", () => ({
  notificationModel: {
    _name: "Notification",
    id: "id",
    workspaceId: "ws",
    userId: "userId",
    readAt: "readAt",
    createdAt: "createdAt",
    commentId: "commentId",
  },
  dealCommentMentionModel: {
    _name: "DealCommentMention",
    workspaceId: "ws",
    userId: "userId",
    readAt: "readAt",
    commentId: "commentId",
  },
}))
vi.mock("@chatbotx.io/utils", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createId: (() => {
    let n = 0
    return () => `id-${++n}`
  })(),
}))
vi.mock("@chatbotx.io/worker-config", () => ({
  NotificationJobAction: { notifyUser: "notifyUser" },
  notificationQueue: { add: (...a: unknown[]) => m.queueAdd(...a) },
}))
vi.mock("../src/platform/realtime-broadcast", () => ({
  sendToWorkspaceMember: (...a: unknown[]) => m.sendToMember(...a),
}))
vi.mock("../src/pipeline/service", () => ({
  pipelineService: {
    findOrFail: async () => ({
      id: "pipe-1",
      workspaceId: "ws-1",
      settings: { access: m.state.pipelineAccess },
    }),
  },
}))
vi.mock("../src/pipeline/access", () => ({
  canViewPipeline: async ({
    pipeline,
    viewer,
  }: {
    pipeline: { settings: { access: string } }
    viewer: { userId: string }
  }) =>
    pipeline.settings.access !== "members" ||
    m.state.pipelineMembers.includes(viewer.userId),
}))
vi.mock("../src/workspace-member/service", () => ({
  workspaceMemberService: {
    findByWorkspaceIdAndUserId: async () => m.state.member,
  },
}))
vi.mock("../src/audit/dispatcher", () => ({ dispatchAuditRecord: vi.fn() }))
vi.mock("../src/logger", () => ({
  logger: { warn: m.logWarn, info: m.logInfo },
}))

const { notificationService } = await import("../src/notification/service")

const INPUT = {
  workspaceId: "ws-1",
  userId: "u-2",
  type: "taskAssigned" as const,
  dealId: "deal-1",
  taskId: "task-1",
  payload: {
    pipelineId: "pipe-1",
    dealTitle: "Roof",
    taskTitle: "Call",
    actorId: "u-1",
  },
}
const ROW = {
  id: "n-1",
  workspaceId: "ws-1",
  userId: "u-2",
  type: "taskAssigned",
  dealId: "deal-1",
  taskId: "task-1",
  commentId: null,
  payload: INPUT.payload,
  readAt: null,
  createdAt: new Date("2026-09-24T12:00:00Z"),
  updatedAt: new Date("2026-09-24T12:00:00Z"),
}

beforeEach(() => {
  vi.clearAllMocks()
  m.state.member = { notificationTypes: {}, notificationChannels: {} }
  m.state.insertReturns = [{ ...ROW }]
  m.state.updateReturns = []
  m.state.selectReturns = []
  m.state.calls.length = 0
  m.state.inserted.length = 0
  m.state.pipelineAccess = "workspace"
  m.state.pipelineMembers = []
})

describe("notificationService.notify", () => {
  test("legacy member ({} prefs): in-app row, push job keyed by the row id, realtime to that user", async () => {
    const out = await notificationService.notify(INPUT)
    expect(out.notification?.id).toBe("n-1")
    expect(out.pushEnqueued).toBe(true)
    expect(m.state.calls).toEqual([
      "insert:Notification",
      "onConflictDoNothing",
    ])
    expect(m.state.inserted[0]).toMatchObject({
      workspaceId: "ws-1",
      userId: "u-2",
      type: "taskAssigned",
      dealId: "deal-1",
      taskId: "task-1",
      commentId: null,
      payload: INPUT.payload,
    })
    expect(m.queueAdd).toHaveBeenCalledWith(
      "notifyUser",
      {
        type: "notifyUser",
        data: {
          workspaceId: "ws-1",
          userId: "u-2",
          notificationType: "taskAssigned",
          dealId: "deal-1",
          taskId: "task-1",
          commentId: null,
          notificationId: "n-1",
          payload: INPUT.payload,
        },
      },
      { jobId: "notify-user-n-1" },
    )
    expect(m.sendToMember).toHaveBeenCalledWith(
      { workspaceId: "ws-1", userId: "u-2" },
      {
        eventType: "notificationCreated",
        data: expect.objectContaining({
          id: "n-1",
          type: "taskAssigned",
          dealId: "deal-1",
          createdAt: "2026-09-24T12:00:00.000Z",
        }),
      },
    )
  })

  test("a members-only pipeline never notifies a non-member (skeptic HIGH: no title leak); a member is notified", async () => {
    m.state.pipelineAccess = "members"
    const out = await notificationService.notify(INPUT)
    expect(out).toEqual({ notification: null, pushEnqueued: false })
    expect(m.state.calls).toEqual([])
    expect(m.queueAdd).not.toHaveBeenCalled()
    expect(m.logInfo).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u-2", pipelineId: "pipe-1" }),
      "notification: recipient cannot view the pipeline, skipped",
    )

    m.state.pipelineMembers = ["u-2"]
    const ok = await notificationService.notify(INPUT)
    expect(ok.notification?.id).toBe("n-1")
  })

  test("a realtime send failure is logged on its own; the row and the push stand", async () => {
    m.sendToMember.mockRejectedValueOnce(new Error("party down"))
    const out = await notificationService.notify(INPUT)
    expect(out.notification?.id).toBe("n-1")
    expect(out.pushEnqueued).toBe(true)
    expect(m.logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ notificationId: "n-1" }),
      "notification: realtime send failed",
    )
  })

  test("not a member = nothing (a stale mention cannot notify a stranger)", async () => {
    m.state.member = undefined
    const out = await notificationService.notify(INPUT)
    expect(out).toEqual({ notification: null, pushEnqueued: false })
    expect(m.state.calls).toEqual([])
    expect(m.queueAdd).not.toHaveBeenCalled()
    expect(m.sendToMember).not.toHaveBeenCalled()
  })

  test("the type switched off = nothing", async () => {
    m.state.member = {
      notificationTypes: { taskAssigned: false },
      notificationChannels: {},
    }
    const out = await notificationService.notify(INPUT)
    expect(out).toEqual({ notification: null, pushEnqueued: false })
    expect(m.state.calls).toEqual([])
  })

  test("inApp off, push on = no row, a push job with notificationId null and an EVENT-derived jobId, no realtime", async () => {
    m.state.member = {
      notificationTypes: {},
      notificationChannels: { inApp: false },
    }
    const out = await notificationService.notify(INPUT)
    expect(out.notification).toBeNull()
    expect(out.pushEnqueued).toBe(true)
    expect(m.state.calls).toEqual([])
    const [, job, opts] = m.queueAdd.mock.calls[0] as unknown[]
    expect(
      (job as { data: { notificationId: unknown } }).data.notificationId,
    ).toBeNull()
    expect((opts as { jobId: string }).jobId).toBe(
      "notify-user-ws-1-u-2-taskAssigned-task-1",
    )
    expect(m.sendToMember).not.toHaveBeenCalled()
  })

  test("push off = row + realtime, no job", async () => {
    m.state.member = {
      notificationTypes: {},
      notificationChannels: { push: false },
    }
    const out = await notificationService.notify(INPUT)
    expect(out.notification?.id).toBe("n-1")
    expect(out.pushEnqueued).toBe(false)
    expect(m.queueAdd).not.toHaveBeenCalled()
    expect(m.sendToMember).toHaveBeenCalledTimes(1)
  })

  test("a mention already notified (partial unique conflict) = nothing further", async () => {
    m.state.insertReturns = []
    const out = await notificationService.notify({
      ...INPUT,
      type: "dealMentioned",
      taskId: null,
      commentId: "c-1",
    })
    expect(out).toEqual({ notification: null, pushEnqueued: false })
    expect(m.queueAdd).not.toHaveBeenCalled()
    expect(m.sendToMember).not.toHaveBeenCalled()
  })

  test("a queue failure is logged, the row and the realtime send still happen", async () => {
    m.queueAdd.mockRejectedValueOnce(new Error("redis down"))
    const out = await notificationService.notify(INPUT)
    expect(out.notification?.id).toBe("n-1")
    expect(out.pushEnqueued).toBe(false)
    expect(m.logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u-2" }),
      "notification: push enqueue failed",
    )
    expect(m.sendToMember).toHaveBeenCalledTimes(1)
  })
})

describe("notificationService reads + marks", () => {
  test("list: limit is clamped to 1..50, one extra row decides nextCursor = <rank>:<id>", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ ...ROW, id: `n-${i}` }))
    m.state.selectReturns = [rows]
    const page = await notificationService.list({
      workspaceId: "ws-1",
      userId: "u-2",
      limit: 2,
    })
    expect(page.data.map((r) => r.id)).toEqual(["n-0", "n-1"])
    expect(page.nextCursor).toBe("1:n-1")

    m.state.selectReturns = [rows.map((r) => ({ ...r, readAt: new Date() }))]
    const read = await notificationService.list({
      workspaceId: "ws-1",
      userId: "u-2",
      limit: 2,
    })
    expect(read.nextCursor).toBe("0:n-1")

    m.state.selectReturns = [rows.slice(0, 2)]
    const last = await notificationService.list({
      workspaceId: "ws-1",
      userId: "u-2",
      limit: 500,
    })
    expect(last.nextCursor).toBeNull()
  })

  test("list with a cursor re-reads only the anchor's createdAt (its rank rides in the token); unknown anchor = empty page; malformed = first page", async () => {
    m.state.selectReturns = [[{ createdAt: ROW.createdAt }], [{ ...ROW }]]
    const page = await notificationService.list({
      workspaceId: "ws-1",
      userId: "u-2",
      cursor: "1:123",
    })
    expect(page.data).toHaveLength(1)
    expect(m.state.selectReturns).toEqual([])

    m.state.selectReturns = [[]]
    await expect(
      notificationService.list({
        workspaceId: "ws-1",
        userId: "u-2",
        cursor: "0:999",
      }),
    ).resolves.toEqual({ data: [], nextCursor: null })
    expect(m.state.selectReturns).toEqual([])

    m.state.selectReturns = [[{ ...ROW }]]
    const first = await notificationService.list({
      workspaceId: "ws-1",
      userId: "u-2",
      cursor: "garbage",
    })
    expect(first.data).toHaveLength(1)
  })

  test("countUnread returns a number, 0 when no row", async () => {
    m.state.selectReturns = [[{ count: 4 }]]
    expect(
      await notificationService.countUnread({
        workspaceId: "ws-1",
        userId: "u-2",
      }),
    ).toBe(4)
    m.state.selectReturns = [[]]
    expect(
      await notificationService.countUnread({
        workspaceId: "ws-1",
        userId: "u-2",
      }),
    ).toBe(0)
  })

  test("markRead: a mention notification also marks its DealCommentMention row; idempotent", async () => {
    m.state.updateReturns = [[{ commentId: "c-1" }], []]
    await expect(
      notificationService.markRead({
        workspaceId: "ws-1",
        userId: "u-2",
        id: "n-1",
      }),
    ).resolves.toEqual({ marked: true })
    expect(m.state.calls).toEqual([
      "update:Notification",
      "update:DealCommentMention",
    ])
    m.state.calls.length = 0
    m.state.updateReturns = [[]]
    await expect(
      notificationService.markRead({
        workspaceId: "ws-1",
        userId: "u-2",
        id: "n-1",
      }),
    ).resolves.toEqual({ marked: false })
    expect(m.state.calls).toEqual(["update:Notification"])
  })

  test("markRead on a task notification touches no mention row", async () => {
    m.state.updateReturns = [[{ commentId: null }]]
    await notificationService.markRead({
      workspaceId: "ws-1",
      userId: "u-2",
      id: "n-1",
    })
    expect(m.state.calls).toEqual(["update:Notification"])
  })

  test("markAllRead: count + one mention update for the comment ids marked", async () => {
    m.state.updateReturns = [[{ commentId: "c-1" }, { commentId: null }], []]
    await expect(
      notificationService.markAllRead({ workspaceId: "ws-1", userId: "u-2" }),
    ).resolves.toEqual({ count: 2 })
    expect(m.state.calls).toEqual([
      "update:Notification",
      "update:DealCommentMention",
    ])
  })
})
