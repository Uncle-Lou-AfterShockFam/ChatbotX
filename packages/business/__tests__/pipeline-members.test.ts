import { beforeEach, describe, expect, test, vi } from "vitest"

/**
 * pipelineMemberService with the database mocked at the query-builder seam
 * (queue-driven, same shape as deal-task-service.test.ts). Pinned: the
 * replace-set validation (workspace membership, duplicates, cap, shape),
 * and the round-robin pick: pipeline row locked FOR UPDATE, next after the
 * cursor in `order`, wrap-around, a departed / unknown cursor restarts at the
 * first member, an empty rotation yields null, and the cursor is written in
 * the same transaction.
 */
const m = vi.hoisted(() => {
  const state = {
    selects: [] as unknown[][],
    inserted: [] as Record<string, unknown>[],
    updates: [] as Record<string, unknown>[],
    calls: [] as string[],
    existingUserIds: [] as string[],
  }
  const chain = (kind: "select" | "update" | "delete") => {
    const self: Record<string, unknown> = {}
    for (const k of ["from", "where", "orderBy", "limit", "set", "for"]) {
      self[k] = (v: unknown) => {
        if (k === "set") {
          state.updates.push(v as Record<string, unknown>)
          state.calls.push(`update:${Object.keys(v as object).join(",")}`)
        }
        if (k === "for") {
          state.calls.push(`for:${String(v)}`)
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
            new Error(
              `mock: no select queued (calls: ${state.calls.join(",")})`,
            ),
          ).then(ok, ko)
        }
        state.calls.push("select")
        return Promise.resolve(next).then(ok, ko)
      }
      state.calls.push(kind)
      return Promise.resolve(undefined).then(ok, ko)
    }
    return self
  }
  const makeTx = () => ({
    select: () => chain("select"),
    update: () => chain("update"),
    delete: () => chain("delete"),
    insert: () => ({
      values: (rows: Record<string, unknown>[]) => {
        state.inserted.push(...rows)
        state.calls.push(`insert:${rows.length}`)
        return { returning: () => Promise.resolve(rows) }
      },
    }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      await fn(makeTx()),
  })
  return { state, makeTx, logWarn: vi.fn() }
})

vi.mock("@chatbotx.io/database/client", () => ({
  db: m.makeTx(),
  and: vi.fn((...c: unknown[]) => ({ c })),
  eq: vi.fn((f: unknown, v: unknown) => ({ f, v })),
  asc: vi.fn((f: unknown) => f),
}))
vi.mock("@chatbotx.io/utils", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createId: () => "new-id",
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
const pipelineFindOrFail = vi.hoisted(() => vi.fn())
vi.mock("../src/pipeline/service", () => ({
  pipelineService: { findOrFail: pipelineFindOrFail },
}))
vi.mock("../src/logger", () => ({
  logger: { warn: m.logWarn, info: vi.fn() },
}))

const { pipelineMemberService } = await import("../src/pipeline/members")

const WS = "ws-1"
const PIPE = "pipe-1"
const tx = m.makeTx() as never

beforeEach(() => {
  vi.clearAllMocks()
  m.state.selects = []
  m.state.inserted.length = 0
  m.state.updates.length = 0
  m.state.calls.length = 0
  m.state.existingUserIds = ["1", "2", "3"]
})

describe("pipelineMemberService.set", () => {
  test("replaces the list in order under the pipeline row lock: delete then insert, order = position, inRotation defaults true", async () => {
    m.state.selects = [[{ id: PIPE }]]
    const rows = await pipelineMemberService.set({
      workspaceId: WS,
      pipelineId: PIPE,
      members: [{ userId: "2" }, { userId: "1", inRotation: false }],
    })
    expect(m.state.calls).toEqual([
      "for:update",
      "select",
      "delete",
      "insert:2",
    ])
    expect(pipelineFindOrFail).not.toHaveBeenCalled()
    expect(rows.map((r) => [r.userId, r.inRotation, r.order])).toEqual([
      ["2", true, 1000],
      ["1", false, 2000],
    ])
  })

  test("an empty list removes everyone and inserts nothing", async () => {
    m.state.selects = [[{ id: PIPE }]]
    await expect(
      pipelineMemberService.set({
        workspaceId: WS,
        pipelineId: PIPE,
        members: [],
      }),
    ).resolves.toEqual([])
    expect(m.state.calls).toEqual(["for:update", "select", "delete"])
  })

  test("with a viewer the pipeline must be visible to them FIRST (404 propagates, nothing written)", async () => {
    pipelineFindOrFail.mockRejectedValueOnce(
      Object.assign(new Error("Pipeline not found"), { httpStatusCode: 404 }),
    )
    await expect(
      pipelineMemberService.set({
        workspaceId: WS,
        pipelineId: PIPE,
        members: [{ userId: "1" }],
        viewer: { userId: "1", permissions: { superAdmin: false } },
      }),
    ).rejects.toMatchObject({ httpStatusCode: 404 })
    expect(pipelineFindOrFail).toHaveBeenCalledWith(
      expect.objectContaining({ id: PIPE, viewer: expect.anything() }),
    )
    expect(m.state.calls).toEqual([])
  })

  test("a user outside the workspace is a 422 naming the ids, before any write", async () => {
    m.state.selects = [[{ id: PIPE }]]
    await expect(
      pipelineMemberService.set({
        workspaceId: WS,
        pipelineId: PIPE,
        members: [{ userId: "1" }, { userId: "9" }],
      }),
    ).rejects.toMatchObject({
      httpStatusCode: 422,
      data: { reason: "notWorkspaceMember", userIds: "9" },
    })
    expect(m.state.calls).toEqual(["for:update", "select"])
  })

  test("a duplicate user, a bad id, a non-list and the cap are 422s before any read", async () => {
    await expect(
      pipelineMemberService.set({
        workspaceId: WS,
        pipelineId: PIPE,
        members: [{ userId: "1" }, { userId: "1" }],
      }),
    ).rejects.toMatchObject({
      httpStatusCode: 422,
      data: { reason: "duplicateMember" },
    })
    await expect(
      pipelineMemberService.set({
        workspaceId: WS,
        pipelineId: PIPE,
        members: [{ userId: "abc" }],
      }),
    ).rejects.toMatchObject({ httpStatusCode: 422, field: "members.0.userId" })
    await expect(
      pipelineMemberService.set({
        workspaceId: WS,
        pipelineId: PIPE,
        members: null as never,
      }),
    ).rejects.toMatchObject({ httpStatusCode: 422 })
    await expect(
      pipelineMemberService.set({
        workspaceId: WS,
        pipelineId: PIPE,
        members: Array.from({ length: 51 }, (_, i) => ({ userId: String(i) })),
      }),
    ).rejects.toMatchObject({
      httpStatusCode: 422,
      data: { reason: "tooManyMembers" },
    })
    expect(m.state.calls).toEqual([])
  })

  test("an unknown pipeline is a 404", async () => {
    m.state.selects = [[]]
    await expect(
      pipelineMemberService.set({
        workspaceId: WS,
        pipelineId: "nope",
        members: [{ userId: "1" }],
      }),
    ).rejects.toMatchObject({ httpStatusCode: 404 })
  })
})

describe("pipelineMemberService.pickRoundRobin", () => {
  const rotation = [{ userId: "1" }, { userId: "2" }, { userId: "3" }]

  test("locks the pipeline row FOR UPDATE and picks the member after the cursor, writing the new cursor", async () => {
    m.state.selects = [[{ id: PIPE, cursor: "1" }], rotation]
    await expect(
      pipelineMemberService.pickRoundRobin({
        workspaceId: WS,
        pipelineId: PIPE,
        tx,
      }),
    ).resolves.toBe("2")
    expect(m.state.calls).toEqual([
      "for:update",
      "select",
      "select",
      "update:roundRobinLastUserId",
      "update",
    ])
    expect(m.state.updates).toEqual([{ roundRobinLastUserId: "2" }])
  })

  test("wraps around after the last member", async () => {
    m.state.selects = [[{ id: PIPE, cursor: "3" }], rotation]
    await expect(
      pipelineMemberService.pickRoundRobin({
        workspaceId: WS,
        pipelineId: PIPE,
        tx,
      }),
    ).resolves.toBe("1")
  })

  test.each([
    [null, "no cursor yet"],
    ["departed", "cursor user left the rotation"],
  ])("cursor %s (%s) restarts at the first member", async (cursor) => {
    m.state.selects = [[{ id: PIPE, cursor }], rotation]
    await expect(
      pipelineMemberService.pickRoundRobin({
        workspaceId: WS,
        pipelineId: PIPE,
        tx,
      }),
    ).resolves.toBe("1")
  })

  test("an empty rotation yields null, warns, and writes no cursor", async () => {
    m.state.selects = [[{ id: PIPE, cursor: "1" }], []]
    await expect(
      pipelineMemberService.pickRoundRobin({
        workspaceId: WS,
        pipelineId: PIPE,
        tx,
      }),
    ).resolves.toBeNull()
    expect(m.logWarn).toHaveBeenCalledTimes(1)
    expect(m.state.updates).toEqual([])
  })

  test("a single member is picked every time", async () => {
    m.state.selects = [[{ id: PIPE, cursor: "1" }], [{ userId: "1" }]]
    await expect(
      pipelineMemberService.pickRoundRobin({
        workspaceId: WS,
        pipelineId: PIPE,
        tx,
      }),
    ).resolves.toBe("1")
  })

  test("an unknown pipeline is a 404 (the lock select returned no row)", async () => {
    m.state.selects = [[]]
    await expect(
      pipelineMemberService.pickRoundRobin({
        workspaceId: WS,
        pipelineId: "x",
        tx,
      }),
    ).rejects.toMatchObject({ httpStatusCode: 404 })
  })
})
