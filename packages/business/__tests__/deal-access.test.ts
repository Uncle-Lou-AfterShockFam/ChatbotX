import { beforeEach, describe, expect, test, vi } from "vitest"

/**
 * The s193 viewer scope, pure parts + the members-only lookup: a super admin
 * is never restricted, `onlyAssignedContacts` (without `contacts`) restricts
 * to the viewer's own deals, a `workspace` pipeline needs no lookup, a
 * `members` pipeline needs one and fails CLOSED on a missing membership.
 */
const isMember = vi.hoisted(() => vi.fn())
vi.mock("../src/pipeline/members", () => ({
  pipelineMemberService: { isMember },
}))

const { canViewPipeline, isUnrestrictedViewer, viewerOwnerFilter } =
  await import("../src/pipeline/access")
const { assignedOnlyUserId } = await import(
  "../src/workspace-member/permissions"
)

const SUPER = { superAdmin: true, contacts: true, onlyAssignedContacts: true }
const FULL = { superAdmin: false, contacts: true, onlyAssignedContacts: false }
const ASSIGNED = {
  superAdmin: false,
  contacts: false,
  onlyAssignedContacts: true,
}
const pipeline = (access: "workspace" | "members") => ({
  id: "pipe-1",
  workspaceId: "ws-1",
  settings: {
    stopCompanyOn: "created" as const,
    defaultCurrency: "USD",
    fieldDefs: [],
    assignOwner: "none" as const,
    access,
  },
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe("assignedOnlyUserId / viewerOwnerFilter", () => {
  test.each([
    [SUPER, undefined, "super admin"],
    [FULL, undefined, "full contacts"],
    [ASSIGNED, "u-1", "assigned only"],
    [{}, undefined, "empty permissions (fails closed to no filter, no access)"],
    [{ onlyAssignedContacts: "yes" }, undefined, "non-boolean flag"],
  ])("%j -> %s (%s)", (permissions, expected) => {
    const viewer = { userId: "u-1", permissions }
    expect(assignedOnlyUserId(viewer)).toBe(expected)
    expect(viewerOwnerFilter(viewer)).toBe(expected)
  })

  test("isUnrestrictedViewer is the superAdmin flag alone", () => {
    expect(isUnrestrictedViewer({ userId: "u", permissions: SUPER })).toBe(true)
    expect(isUnrestrictedViewer({ userId: "u", permissions: FULL })).toBe(false)
    expect(isUnrestrictedViewer({ userId: "u", permissions: {} })).toBe(false)
  })
})

describe("canViewPipeline", () => {
  test("a workspace pipeline is visible to every viewer without a lookup", async () => {
    await expect(
      canViewPipeline({
        viewer: { userId: "u-1", permissions: ASSIGNED },
        pipeline: pipeline("workspace"),
      }),
    ).resolves.toBe(true)
    expect(isMember).not.toHaveBeenCalled()
  })

  test("a members pipeline: super admin without a lookup, member yes, non-member no", async () => {
    await expect(
      canViewPipeline({
        viewer: { userId: "u-1", permissions: SUPER },
        pipeline: pipeline("members"),
      }),
    ).resolves.toBe(true)
    expect(isMember).not.toHaveBeenCalled()

    isMember.mockResolvedValueOnce(true)
    await expect(
      canViewPipeline({
        viewer: { userId: "u-1", permissions: FULL },
        pipeline: pipeline("members"),
      }),
    ).resolves.toBe(true)
    expect(isMember).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        pipelineId: "pipe-1",
        userId: "u-1",
      }),
    )

    isMember.mockResolvedValueOnce(false)
    await expect(
      canViewPipeline({
        viewer: { userId: "u-2", permissions: FULL },
        pipeline: pipeline("members"),
      }),
    ).resolves.toBe(false)
  })
})
