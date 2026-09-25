import { beforeEach, describe, expect, test, vi } from "vitest"

/**
 * s198 self-service notification preferences: a member may change ONLY
 * taskAssigned / dealMentioned / inApp / push on their OWN row, as a jsonb
 * MERGE (legacy admin keys survive), never permissions.
 */
const mocks = vi.hoisted(() => ({
  updateReturning: vi.fn(),
  updateWhere: vi.fn(),
  updateSet: vi.fn(),
  update: vi.fn(),
  findFirst: vi.fn(),
  invalidateCacheByTags: vi.fn(),
}))

vi.mock("@chatbotx.io/database/client", () => ({
  and: (...args: unknown[]) => ({ and: args }),
  db: {
    update: mocks.update,
    query: { workspaceMemberModel: { findFirst: mocks.findFirst } },
  },
  eq: (...args: unknown[]) => ({ eq: args }),
  sql: (s: TemplateStringsArray, ...v: unknown[]) => ({ sql: s.join("?"), v }),
}))
vi.mock("@chatbotx.io/database/partials", () => ({
  workspaceMemberRoles: { enum: { owner: "owner" } },
}))
vi.mock("@chatbotx.io/database/schema", () => ({
  workspaceMemberModel: {
    id: "workspaceMember.id",
    workspaceId: "workspaceMember.workspaceId",
    userId: "workspaceMember.userId",
    notificationTypes: "workspaceMember.notificationTypes",
    notificationChannels: "workspaceMember.notificationChannels",
  },
}))
vi.mock("@chatbotx.io/database/utils", () => ({
  getPaginationWithDefaults: vi.fn(() => ({ limit: 10, offset: 0 })),
  likeContains: (value: string) => `%${value}%`,
}))
vi.mock("@chatbotx.io/database/repositories", () => ({
  workspaceMemberRepository: { listPermissionsByUserIds: vi.fn() },
}))
vi.mock("@chatbotx.io/redis", () => ({
  withCache: vi.fn(),
  invalidateCacheByTags: mocks.invalidateCacheByTags,
}))
vi.mock("../src/audit/dispatcher", () => ({ dispatchAuditRecord: vi.fn() }))
vi.mock("../src/workspace-usage/service", () => ({
  workspaceUsageService: { increment: vi.fn(), decrement: vi.fn() },
}))

const { workspaceMemberService } = await import(
  "../src/workspace-member/service"
)
const { parseOwnNotificationPrefsPatch, ownNotificationPrefs } = await import(
  "../src/workspace-member/notification-prefs"
)

const ROW = {
  notificationTypes: { notifyAdmin: true, taskAssigned: false },
  notificationChannels: { email: true },
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.update.mockReturnValue({ set: mocks.updateSet })
  mocks.updateSet.mockReturnValue({ where: mocks.updateWhere })
  mocks.updateWhere.mockReturnValue({ returning: mocks.updateReturning })
  mocks.updateReturning.mockResolvedValue([ROW])
})

const own = (patch: unknown) =>
  workspaceMemberService.updateOwnNotificationPrefs({
    workspaceId: "ws-1",
    userId: "user-1",
    patch,
  })

describe("updateOwnNotificationPrefs", () => {
  test("merges only the sent group, as jsonb || patch, on the caller's own row", async () => {
    const out = await own({ types: { taskAssigned: false } })
    const set = mocks.updateSet.mock.calls[0][0] as Record<string, unknown>
    expect(Object.keys(set)).toEqual(["notificationTypes"])
    expect(set.notificationTypes).toMatchObject({
      sql: expect.stringContaining("||"),
      v: expect.arrayContaining([JSON.stringify({ taskAssigned: false })]),
    })
    expect(mocks.updateWhere).toHaveBeenCalledWith({
      and: [
        { eq: ["workspaceMember.workspaceId", "ws-1"] },
        { eq: ["workspaceMember.userId", "user-1"] },
      ],
    })
    // the answer is narrowed to the four self-service keys
    expect(out).toEqual({
      types: { taskAssigned: false, dealMentioned: true },
      channels: { inApp: true, push: true },
    })
    expect(mocks.invalidateCacheByTags).toHaveBeenCalled()
  })

  test("both groups at once set both columns and nothing else", async () => {
    await own({
      types: { dealMentioned: false },
      channels: { push: false, inApp: true },
    })
    const set = mocks.updateSet.mock.calls[0][0] as Record<string, unknown>
    expect(Object.keys(set).sort()).toEqual([
      "notificationChannels",
      "notificationTypes",
    ])
  })

  test("no member row = 404 and no cache bust", async () => {
    mocks.updateReturning.mockResolvedValue([])
    await expect(own({ channels: { push: true } })).rejects.toMatchObject({
      httpStatusCode: 404,
    })
    expect(mocks.invalidateCacheByTags).not.toHaveBeenCalled()
  })

  test("a missing workspace or user is a 404 before any write", async () => {
    for (const ids of [
      { workspaceId: "", userId: "user-1" },
      { workspaceId: "ws-1", userId: "" },
    ]) {
      await expect(
        workspaceMemberService.updateOwnNotificationPrefs({
          ...ids,
          patch: { types: { taskAssigned: true } },
        }),
      ).rejects.toMatchObject({ httpStatusCode: 404 })
    }
    expect(mocks.update).not.toHaveBeenCalled()
  })

  test("anything outside the closed shape is a 422 before any write", async () => {
    for (const patch of [
      null,
      undefined,
      "types",
      [],
      {},
      { types: {} },
      { types: null },
      { types: [] },
      { permissions: { superAdmin: true } },
      { types: { taskAssigned: true }, permissions: { superAdmin: true } },
      { types: { notifyAdmin: true } },
      { channels: { email: true } },
      { types: { taskAssigned: "yes" } },
      { channels: { push: 1 } },
      { types: { taskAssigned: true, __proto__: { x: 1 } }, role: "owner" },
    ]) {
      await expect(own(patch)).rejects.toMatchObject({
        code: "validation",
        data: { reason: "invalidPrefs" },
      })
    }
    expect(mocks.update).not.toHaveBeenCalled()
  })
})

describe("parseOwnNotificationPrefsPatch fuzz", () => {
  test("random objects never yield a key outside the four self-service keys", () => {
    const keys = [
      "types",
      "channels",
      "permissions",
      "taskAssigned",
      "dealMentioned",
      "inApp",
      "push",
      "notifyAdmin",
      "email",
      "role",
    ]
    const values = [true, false, 0, 1, "true", null, {}, []]
    let seed = 198
    const rand = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return Math.floor((seed / 2_147_483_648) * n)
    }
    const gen = (depth: number): unknown => {
      if (depth === 0 || rand(3) === 0) {
        return values[rand(values.length)]
      }
      const o: Record<string, unknown> = {}
      for (let i = rand(4); i > 0; i--) {
        o[keys[rand(keys.length)]] = gen(depth - 1)
      }
      return o
    }
    const allowed = {
      types: ["taskAssigned", "dealMentioned"],
      channels: ["inApp", "push"],
    } as Record<string, string[]>
    for (let n = 0; n < 2000; n++) {
      const out = parseOwnNotificationPrefsPatch(gen(3))
      if (out === null) {
        continue
      }
      for (const [group, flags] of Object.entries(out)) {
        expect(Object.keys(allowed)).toContain(group)
        for (const [key, flag] of Object.entries(flags ?? {})) {
          expect(allowed[group]).toContain(key)
          expect(typeof flag).toBe("boolean")
        }
      }
    }
  })
})

describe("getOwnNotificationPrefs", () => {
  test("resolves the caller's row (legacy {} = on) and 404s without one", async () => {
    mocks.findFirst.mockResolvedValueOnce({
      notificationTypes: {},
      notificationChannels: null,
    })
    expect(
      await workspaceMemberService.getOwnNotificationPrefs({
        workspaceId: "ws-1",
        userId: "user-1",
      }),
    ).toEqual(ownNotificationPrefs({}))
    mocks.findFirst.mockResolvedValueOnce(undefined)
    await expect(
      workspaceMemberService.getOwnNotificationPrefs({
        workspaceId: "ws-1",
        userId: "user-1",
      }),
    ).rejects.toMatchObject({ httpStatusCode: 404 })
  })
})
