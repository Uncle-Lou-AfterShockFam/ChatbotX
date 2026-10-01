// @vitest-environment node

import { beforeEach, describe, expect, test, vi } from "vitest"

/**
 * s229b: `superAdminAuthorizedMiddleware` (mailbox senders hold credentials)
 * lets a workspace admin/owner through and answers 403 to every other
 * member, whatever else they may access.
 */
const { findMembership, resolveWorkspaceAccess } = vi.hoisted(() => ({
  findMembership: vi.fn(),
  resolveWorkspaceAccess: vi.fn(),
}))

vi.mock("@chatbotx.io/business", () => ({
  workspaceMemberService: { findMembership },
  resolveWorkspaceAccess,
  isWorkspaceScheduledForDeletion: vi.fn().mockReturnValue(false),
  userQuotaService: {
    getAccessState: vi.fn().mockResolvedValue({ blocked: false }),
  },
  quotaEnforcementService: { isAtLimit: vi.fn().mockResolvedValue(false) },
}))
vi.mock("@chatbotx.io/business/audit", () => ({
  withAuditContext: (_actor: unknown, fn: () => unknown) => fn(),
}))
vi.mock("@/env", () => ({ isCloud: () => true }))
vi.mock("@/lib/auth/auth", () => ({
  auth: { api: { getSession: vi.fn() } },
}))
vi.mock("@/lib/rate-limit/guest-rate-limit", () => ({
  getGuestClientIp: vi.fn().mockReturnValue("127.0.0.1"),
}))

const { superAdminAuthorizedMiddleware, superAdminRealMemberMiddleware } =
  await import("@/middlewares/auth")

const next = vi.fn(async () => ({ output: "ok" }))

const call = (method: string, mw: unknown = superAdminAuthorizedMiddleware) =>
  (mw as unknown as (opts: unknown, workspaceId: string) => Promise<unknown>)(
    {
      context: { user: { id: "user-1" }, headers: new Headers() },
      next,
      procedure: { "~orpc": { route: { method } } },
    },
    "ws-1",
  )

const asMember = (
  permissions: Record<string, unknown>,
  isSupportSession = false,
) => {
  const member = { workspace: { id: "ws-1", ownerId: "owner-1" }, permissions }
  findMembership.mockResolvedValue(isSupportSession ? undefined : member)
  resolveWorkspaceAccess.mockResolvedValue({
    workspace: member.workspace,
    member,
    isSupportSession,
  })
}

beforeEach(() => vi.clearAllMocks())

describe("superAdminAuthorizedMiddleware (s229b)", () => {
  test("a member without admin gets 403 on reads and writes alike", async () => {
    for (const permissions of [
      {},
      { contacts: true, broadcast: true, flows: true },
      { superAdmin: false, contacts: true },
      { superAdmin: "true" },
    ]) {
      asMember(permissions)
      for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
        await expect(call(method)).rejects.toMatchObject({
          code: "FORBIDDEN",
          status: 403,
        })
      }
    }
    expect(next).not.toHaveBeenCalled()
  })

  test("an admin passes", async () => {
    asMember({ superAdmin: true })
    for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
      await expect(call(method)).resolves.toMatchObject({ output: "ok" })
    }
    expect(next).toHaveBeenCalledTimes(4)
  })

  test("a non-member is UNAUTHORIZED", async () => {
    findMembership.mockResolvedValue(undefined)
    resolveWorkspaceAccess.mockResolvedValue(undefined)
    await expect(call("GET")).rejects.toMatchObject({ code: "UNAUTHORIZED" })
  })
})

describe("superAdminRealMemberMiddleware (s231b, owner 2026-10-01)", () => {
  test("a platform-support session (synthetic superAdmin) is FORBIDDEN on every method; the plain gate still lets it through", async () => {
    asMember({ superAdmin: true }, true)
    for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
      await expect(
        call(method, superAdminRealMemberMiddleware),
      ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 })
    }
    expect(next).not.toHaveBeenCalled()
    await expect(call("POST")).resolves.toMatchObject({ output: "ok" })
  })

  test("a real admin passes; a real non-admin is still refused", async () => {
    asMember({ superAdmin: true })
    await expect(
      call("POST", superAdminRealMemberMiddleware),
    ).resolves.toMatchObject({ output: "ok" })
    asMember({ contacts: true })
    await expect(
      call("POST", superAdminRealMemberMiddleware),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })
})
