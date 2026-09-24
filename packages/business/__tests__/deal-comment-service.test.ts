import { beforeEach, describe, expect, test, vi } from "vitest"

/**
 * dealCommentService with the database mocked at the query-builder seam
 * (queue-driven, same shape as deal-task-service.test.ts). Pinned: create =
 * comment + mention rows + `commented` activity in the tx, THEN one
 * `dealMentioned` per mentioned user; a contact-less deal emits nothing;
 * mention validation (workspace member, pipeline member on members-only,
 * cap 20, cap 1000); update keeps old mentions and emits only the added
 * ones; author-only edit / delete unless super admin; body guards.
 */
const m = vi.hoisted(() => {
  const state = {
    selects: [] as unknown[][],
    updates: [] as unknown[][],
    inserted: [] as { table: string; rows: Record<string, unknown>[] }[],
    calls: [] as string[],
    existingUserIds: [] as string[],
    pipelineMembers: [] as string[],
    pipelineAccess: "workspace" as "workspace" | "members",
  }
  const chain = (kind: "select" | "update" | "delete") => {
    const self: Record<string, unknown> = {}
    for (const k of ["from", "where", "orderBy", "limit", "set", "returning"]) {
      self[k] = (v: unknown) => {
        if (k === "set") {
          state.calls.push(`update:${Object.keys(v as object).join(",")}`)
        }
        return self
      }
    }
    // biome-ignore lint/suspicious/noThenProperty: awaitable like a drizzle query
    self.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => {
      if (kind === "select") {
        const next = state.selects.shift()
        if (next === undefined) {
          return Promise.reject(
            new Error(`mock: no select queued (${state.calls.join(",")})`),
          ).then(ok, ko)
        }
        state.calls.push("select")
        return Promise.resolve(next).then(ok, ko)
      }
      if (kind === "update") {
        const next = state.updates.shift() ?? []
        return Promise.resolve(next).then(ok, ko)
      }
      state.calls.push("delete")
      return Promise.resolve([]).then(ok, ko)
    }
    return self
  }
  const makeTx = () => ({
    select: () => chain("select"),
    update: () => chain("update"),
    delete: () => chain("delete"),
    insert: (model: { _name: string }) => ({
      values: (v: Record<string, unknown> | Record<string, unknown>[]) => {
        const rows = Array.isArray(v) ? v : [v]
        state.inserted.push({ table: model._name, rows })
        state.calls.push(
          model._name === "DealActivity"
            ? `activity:${String(rows[0]?.type)}`
            : `insert:${model._name}:${rows.length}`,
        )
        const done = {
          returning: () =>
            Promise.resolve(
              rows.map((r) => ({
                ...r,
                createdAt: new Date(),
                updatedAt: new Date(),
              })),
            ),
          onConflictDoNothing: () => done,
          // biome-ignore lint/suspicious/noThenProperty: awaitable like a drizzle insert
          then: (ok: (v: unknown) => unknown) =>
            Promise.resolve(undefined).then(ok),
        }
        return done
      },
    }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      await fn(makeTx()),
  })
  return {
    state,
    makeTx,
    dealFindOrFail: vi.fn(),
    emitMentioned: vi.fn((...a: unknown[]) => {
      state.calls.push(
        `emit:dealMentioned:${String((a[2] as { mentionedUserId: string }).mentionedUserId)}`,
      )
      return Promise.resolve()
    }),
    logWarn: vi.fn(),
    logInfo: vi.fn(),
  }
})

vi.mock("@chatbotx.io/database/client", () => ({
  db: m.makeTx(),
  and: vi.fn((...c: unknown[]) => ({ c })),
  eq: vi.fn((f: unknown, v: unknown) => ({ f, v })),
  asc: vi.fn((f: unknown) => f),
  desc: vi.fn((f: unknown) => f),
  sql: Object.assign(
    vi.fn((s: TemplateStringsArray, ...v: unknown[]) => ({ s, v })),
    {},
  ),
}))
vi.mock("@chatbotx.io/database/schema", () => ({
  dealActivityModel: { _name: "DealActivity" },
  dealCommentModel: {
    _name: "DealComment",
    id: "id",
    dealId: "dealId",
    workspaceId: "ws",
    createdAt: "createdAt",
  },
  dealCommentMentionModel: {
    _name: "DealCommentMention",
    id: "id",
    workspaceId: "ws",
    commentId: "commentId",
    userId: "userId",
    readAt: "readAt",
  },
}))
vi.mock("@chatbotx.io/utils", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createId: (() => {
    let n = 0
    return () => `id-${++n}`
  })(),
}))
vi.mock("@chatbotx.io/events", () => ({
  emitDealMentioned: (...a: unknown[]) => m.emitMentioned(...a),
}))
vi.mock("../src/deal/service", () => ({
  dealService: { findOrFail: (...a: unknown[]) => m.dealFindOrFail(...a) },
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
vi.mock("../src/pipeline/members", () => ({
  pipelineMemberService: {
    list: async () => m.state.pipelineMembers.map((userId) => ({ userId })),
  },
}))
vi.mock("../src/workspace-member/service", () => ({
  workspaceMemberService: {
    listExistingUserIds: async ({ userIds }: { userIds: string[] }) =>
      userIds
        .filter((id) => m.state.existingUserIds.includes(id))
        .map((userId) => ({ userId })),
  },
}))
vi.mock("../src/audit/dispatcher", () => ({ dispatchAuditRecord: vi.fn() }))
vi.mock("../src/logger", () => ({
  logger: { warn: m.logWarn, info: m.logInfo },
}))
// s194: per-user notifications, recorded apart from `calls`
const notify = vi.fn(async () => ({ notification: null, pushEnqueued: false }))
const markReadByComment = vi.fn(async () => undefined)
vi.mock("../src/notification/service", () => ({
  notificationService: {
    notify: (...a: unknown[]) => notify(...a),
    markReadByComment: (...a: unknown[]) => markReadByComment(...a),
  },
}))

const { dealCommentService } = await import("../src/deal-comment/service")

const WS = "ws-1"
const TRAILING_HIGH_SURROGATE = /[\uD800-\uDBFF]$/
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
  ownerId: null,
  companyId: null,
  contactId: "contact-1",
}
const AUTHOR = {
  userId: "u-1",
  permissions: { superAdmin: false, contacts: true },
}
const SUPER = { userId: "u-9", permissions: { superAdmin: true } }
const OTHER = {
  userId: "u-3",
  permissions: { superAdmin: false, contacts: true },
}
const COMMENT = {
  id: "c-1",
  workspaceId: WS,
  dealId: "deal-1",
  authorId: "u-1",
  body: "hello @[Two](u:2)",
  mentions: [{ userId: "2", label: "Two" }],
  editedAt: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  m.state.selects = []
  m.state.updates = []
  m.state.inserted.length = 0
  m.state.calls.length = 0
  m.state.existingUserIds = ["1", "2", "3"]
  m.state.pipelineMembers = []
  m.state.pipelineAccess = "workspace"
  m.dealFindOrFail.mockResolvedValue({ ...DEAL })
})

describe("dealCommentService.create", () => {
  test("comment + mention rows + commented activity in the tx, THEN one dealMentioned per user with the excerpt", async () => {
    m.state.selects = [[{ count: 0 }]]
    const comment = await dealCommentService.create({
      workspaceId: WS,
      dealId: "deal-1",
      body: "  ping @[Two](u:2) and @[Three](u:3)  ",
      actorId: "u-1",
      viewer: AUTHOR,
    })
    expect(comment.mentions).toEqual([
      { userId: "2", label: "Two" },
      { userId: "3", label: "Three" },
    ])
    expect(m.state.calls).toEqual([
      "select",
      "insert:DealComment:1",
      "insert:DealCommentMention:2",
      "activity:commented",
      "emit:dealMentioned:2",
      "emit:dealMentioned:3",
    ])
    expect(m.emitMentioned).toHaveBeenCalledWith(
      WS,
      "contact-1",
      expect.objectContaining({
        dealId: "deal-1",
        pipelineId: "pipe-1",
        commentId: comment.id,
        authorId: "u-1",
        mentionedUserId: "2",
        excerpt: "ping @Two and @Three",
      }),
    )
    const activity = m.state.inserted.find((i) => i.table === "DealActivity")
    expect(activity?.rows[0]).toMatchObject({
      type: "commented",
      actorId: "u-1",
      payload: { commentId: comment.id, mentionedUserIds: ["2", "3"] },
    })
    expect(m.dealFindOrFail).toHaveBeenCalledWith(
      expect.objectContaining({ id: "deal-1", viewer: AUTHOR }),
    )
  })

  test("the excerpt clips at 500 code points without splitting a surrogate pair", async () => {
    m.state.selects = [[{ count: 0 }]]
    const body = `${"a".repeat(498)}\u{1F600}\u{1F600}${"b".repeat(50)}`
    await dealCommentService.create({ workspaceId: WS, dealId: "deal-1", body })
    const activity = m.state.inserted.find((i) => i.table === "DealActivity")
    const excerpt = (activity?.rows[0].payload as { excerpt: string }).excerpt
    expect(Array.from(excerpt)).toHaveLength(500)
    expect(excerpt.endsWith("\u2026")).toBe(true)
    expect(excerpt).not.toMatch(TRAILING_HIGH_SURROGATE)
    expect(Array.from(excerpt).at(-2)).toBe("\u{1F600}")
  })

  test("no mentions = no mention rows and no event; a contact-less deal writes rows but emits nothing", async () => {
    m.state.selects = [[{ count: 0 }]]
    await dealCommentService.create({
      workspaceId: WS,
      dealId: "deal-1",
      body: "plain",
    })
    expect(m.state.calls).toEqual([
      "select",
      "insert:DealComment:1",
      "activity:commented",
    ])

    m.state.calls.length = 0
    m.state.selects = [[{ count: 0 }]]
    m.dealFindOrFail.mockResolvedValue({ ...DEAL, contactId: null })
    await dealCommentService.create({
      workspaceId: WS,
      dealId: "deal-1",
      body: "@[Two](u:2)",
    })
    expect(m.state.calls).toEqual([
      "select",
      "insert:DealComment:1",
      "insert:DealCommentMention:1",
      "activity:commented",
    ])
    expect(m.emitMentioned).not.toHaveBeenCalled()
    expect(m.logInfo).toHaveBeenCalled()
  })

  test("a mentioned user outside the workspace is a 422 naming the id, before any write", async () => {
    m.state.selects = [[{ count: 0 }]]
    await expect(
      dealCommentService.create({
        workspaceId: WS,
        dealId: "deal-1",
        body: "@[Two](u:2) @[Ghost](u:99)",
      }),
    ).rejects.toMatchObject({
      httpStatusCode: 422,
      data: { reason: "mentionNotMember", userIds: "99" },
    })
    expect(m.state.calls).toEqual(["select"])
  })

  test("on a members-only pipeline a workspace member who is not a pipeline member cannot be mentioned", async () => {
    m.state.pipelineAccess = "members"
    m.state.pipelineMembers = ["2"]
    m.state.selects = [[{ count: 0 }]]
    await expect(
      dealCommentService.create({
        workspaceId: WS,
        dealId: "deal-1",
        body: "@[Two](u:2) @[Three](u:3)",
      }),
    ).rejects.toMatchObject({ httpStatusCode: 422, data: { userIds: "3" } })
    m.state.selects = [[{ count: 0 }]]
    await expect(
      dealCommentService.create({
        workspaceId: WS,
        dealId: "deal-1",
        body: "@[Two](u:2)",
      }),
    ).resolves.toMatchObject({ mentions: [{ userId: "2", label: "Two" }] })
  })

  test("caps: 21 mentions and 1000 comments are 422s; empty / non-string / 4001-char bodies too", async () => {
    const many = Array.from(
      { length: 21 },
      (_, i) => `@[U${i}](u:${i + 1})`,
    ).join(" ")
    await expect(
      dealCommentService.create({
        workspaceId: WS,
        dealId: "deal-1",
        body: many,
      }),
    ).rejects.toMatchObject({
      httpStatusCode: 422,
      data: { reason: "tooManyMentions" },
    })
    m.state.selects = [[{ count: 1000 }]]
    await expect(
      dealCommentService.create({
        workspaceId: WS,
        dealId: "deal-1",
        body: "x",
      }),
    ).rejects.toMatchObject({
      httpStatusCode: 422,
      data: { reason: "tooManyComments" },
    })
    for (const body of ["", "   ", null, 42, "y".repeat(4001)]) {
      await expect(
        dealCommentService.create({
          workspaceId: WS,
          dealId: "deal-1",
          body: body as never,
        }),
      ).rejects.toMatchObject({ httpStatusCode: 422, field: "body" })
    }
    expect(m.state.inserted).toEqual([])
  })
})

describe("dealCommentService s194 notifications", () => {
  test("create notifies every mentioned user but the author, contact-less deal included", async () => {
    m.state.selects = [[{ count: 0 }]]
    m.dealFindOrFail.mockResolvedValue({ ...DEAL, contactId: null })
    const comment = await dealCommentService.create({
      workspaceId: WS,
      dealId: "deal-1",
      body: "me @[One](u:1) and @[Two](u:2)",
      actorId: "1",
    })
    expect(m.emitMentioned).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith({
      workspaceId: WS,
      userId: "2",
      type: "dealMentioned",
      dealId: "deal-1",
      commentId: comment.id,
      payload: {
        pipelineId: "pipe-1",
        dealTitle: "Roof",
        actorId: "1",
        excerpt: "me @One and @Two",
      },
    })
  })

  test("update notifies only the ADDED mentions; a notify failure is logged, never thrown", async () => {
    m.state.selects = [[COMMENT]]
    m.state.updates = [
      [{ ...COMMENT, body: "hello @[Two](u:2) @[Three](u:3)" }],
    ]
    notify.mockRejectedValueOnce(new Error("boom"))
    await dealCommentService.update({
      workspaceId: WS,
      dealId: "deal-1",
      commentId: "c-1",
      body: "hello @[Two](u:2) @[Three](u:3)",
      actorId: "u-1",
      viewer: AUTHOR,
    })
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0]).toMatchObject({ userId: "3" })
    expect(m.logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ commentId: "c-1", userId: "3" }),
      "deal-comment: notify failed",
    )
  })

  test("markMentionRead also marks the notification, only when a row was marked", async () => {
    m.state.updates = [[{ id: "m-1" }], []]
    await dealCommentService.markMentionRead({
      workspaceId: WS,
      commentId: "c-1",
      userId: "2",
    })
    expect(markReadByComment).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WS,
        commentId: "c-1",
        userId: "2",
      }),
    )
    await dealCommentService.markMentionRead({
      workspaceId: WS,
      commentId: "c-1",
      userId: "2",
    })
    expect(markReadByComment).toHaveBeenCalledTimes(1)
  })
})

describe("dealCommentService.update / remove", () => {
  test("update keeps earlier mentions, inserts + emits only the added ones, stamps editedAt", async () => {
    m.state.selects = [[COMMENT]]
    m.state.updates = [
      [
        {
          ...COMMENT,
          body: "hello @[Two](u:2) @[Three](u:3)",
          editedAt: new Date(),
        },
      ],
    ]
    const updated = await dealCommentService.update({
      workspaceId: WS,
      dealId: "deal-1",
      commentId: "c-1",
      body: "hello @[Two](u:2) @[Three](u:3)",
      actorId: "u-1",
      viewer: AUTHOR,
    })
    expect(updated.body).toContain("Three")
    expect(m.state.calls).toEqual([
      "select",
      "update:body,mentions,editedAt",
      "insert:DealCommentMention:1",
      "emit:dealMentioned:3",
    ])
    const rows = m.state.inserted.find((i) => i.table === "DealCommentMention")
    expect(rows?.rows.map((r) => r.userId)).toEqual(["3"])
  })

  test("an earlier mention whose user left the workspace does not block an edit; its label is refreshed from the body", async () => {
    m.state.existingUserIds = ["1"] // user 2 is gone
    m.state.selects = [[COMMENT]]
    m.state.updates = [[{ ...COMMENT, body: "hello @[Bob](u:2) fixed" }]]
    await expect(
      dealCommentService.update({
        workspaceId: WS,
        dealId: "deal-1",
        commentId: "c-1",
        body: "hello @[Bob](u:2) fixed",
        actorId: "u-1",
        viewer: AUTHOR,
      }),
    ).resolves.toBeDefined()
    expect(m.emitMentioned).not.toHaveBeenCalled()
    expect(m.state.calls).toEqual(["select", "update:body,mentions,editedAt"])
    // a NEW mention of a departed user is still refused
    m.state.selects = [[COMMENT]]
    await expect(
      dealCommentService.update({
        workspaceId: WS,
        dealId: "deal-1",
        commentId: "c-1",
        body: "hello @[Two](u:2) @[Three](u:3)",
        actorId: "u-1",
        viewer: AUTHOR,
      }),
    ).rejects.toMatchObject({
      data: { reason: "mentionNotMember", userIds: "3" },
    })
  })

  test("removing a token keeps the old mention (its row may be read) and emits nothing", async () => {
    m.state.selects = [[COMMENT]]
    m.state.updates = [[{ ...COMMENT, body: "hello" }]]
    await dealCommentService.update({
      workspaceId: WS,
      dealId: "deal-1",
      commentId: "c-1",
      body: "hello",
      actorId: "u-1",
      viewer: AUTHOR,
    })
    expect(m.emitMentioned).not.toHaveBeenCalled()
    expect(m.state.calls).toEqual(["select", "update:body,mentions,editedAt"])
  })

  test("another member cannot edit or delete; a super admin can; no viewer (API token) can", async () => {
    m.state.selects = [[COMMENT]]
    await expect(
      dealCommentService.update({
        workspaceId: WS,
        dealId: "deal-1",
        commentId: "c-1",
        body: "x",
        actorId: "u-3",
        viewer: OTHER,
      }),
    ).rejects.toMatchObject({
      httpStatusCode: 422,
      data: { reason: "notCommentAuthor" },
    })
    m.state.selects = [[COMMENT]]
    await expect(
      dealCommentService.remove({
        workspaceId: WS,
        dealId: "deal-1",
        commentId: "c-1",
        actorId: "u-3",
        viewer: OTHER,
      }),
    ).rejects.toMatchObject({ data: { reason: "notCommentAuthor" } })
    m.state.selects = [[COMMENT]]
    await dealCommentService.remove({
      workspaceId: WS,
      dealId: "deal-1",
      commentId: "c-1",
      actorId: "u-9",
      viewer: SUPER,
    })
    m.state.selects = [[COMMENT]]
    await dealCommentService.remove({
      workspaceId: WS,
      dealId: "deal-1",
      commentId: "c-1",
    })
    expect(m.state.calls.filter((c) => c === "delete")).toHaveLength(2)
  })

  test("an unknown comment is a 404; with a viewer the DEAL is checked first", async () => {
    m.state.selects = [[]]
    await expect(
      dealCommentService.findOrFail({
        workspaceId: WS,
        dealId: "deal-1",
        commentId: "nope",
        viewer: AUTHOR,
      }),
    ).rejects.toMatchObject({ httpStatusCode: 404 })
    expect(m.dealFindOrFail).toHaveBeenCalledWith(
      expect.objectContaining({ viewer: AUTHOR }),
    )
  })

  test("markMentionRead is idempotent (0 rows the second time)", async () => {
    m.state.updates = [[{ id: "m-1" }], []]
    await expect(
      dealCommentService.markMentionRead({
        workspaceId: WS,
        commentId: "c-1",
        userId: "2",
      }),
    ).resolves.toEqual({ marked: true })
    await expect(
      dealCommentService.markMentionRead({
        workspaceId: WS,
        commentId: "c-1",
        userId: "2",
      }),
    ).resolves.toEqual({ marked: false })
  })
})
