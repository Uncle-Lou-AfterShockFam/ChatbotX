import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

/**
 * s233a: `/invitations/<code>` was a 500 for an unknown or expired code
 * (`findOrFail` threw) and sent the raw workspace row (deprecated plaintext
 * `token`) + the inviter's user row to the client card. Now every failure is
 * one invalid-invitation card and the card gets a projection only.
 */
const mocks = vi.hoisted(() => ({
  findByCode: vi.fn(),
  findNameAndEmail: vi.fn(),
  findWorkspace: vi.fn(),
  execute: vi.fn(),
}))

vi.mock("@chatbotx.io/business", () => ({
  invitationService: { findByCode: mocks.findByCode },
  userService: { findNameAndEmail: mocks.findNameAndEmail },
  workspaceService: { find: mocks.findWorkspace },
}))
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}))
vi.mock("next-safe-action/hooks", () => ({
  useAction: () => ({ execute: mocks.execute, isPending: false }),
}))
vi.mock("@/features/invitations/actions/accept-invitation", () => ({
  acceptInvitationAction: {},
}))
vi.mock("@/features/tenant", () => ({
  useTenantSettings: () => ({ storageUrl: "https://storage.example.com" }),
}))

const { findInvitation } = await import("@/features/invitations/queries")
const { default: InvitationsPage } = await import(
  "@/app/(no-sidebar)/invitations/[code]/page"
)

const future = new Date(Date.now() + 86_400_000)
const past = new Date(Date.now() - 1000)
const invitationRow = {
  id: "1",
  code: "abc",
  expiresAt: future,
  invitedBy: "u1",
  workspaceId: "w1",
  email: "invitee@example.com",
}
const workspaceRow = {
  id: "w1",
  name: "Acme",
  logo: null,
  scheduledDeletionAt: null,
  token: "PLAINTEXT-WORKSPACE-TOKEN",
  ownerId: "u1",
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.findByCode.mockResolvedValue(invitationRow)
  mocks.findNameAndEmail.mockResolvedValue({
    name: "Lou",
    email: "lou@example.com",
  })
  mocks.findWorkspace.mockResolvedValue(workspaceRow)
})

describe("findInvitation", () => {
  test("projects to the fields the card renders: no workspace token, no inviter email", async () => {
    const view = await findInvitation({ code: "abc" })
    expect(view).toEqual({
      code: "abc",
      inviterName: "Lou",
      workspace: { name: "Acme", logo: null, scheduledDeletionAt: null },
    })
    expect(JSON.stringify(view)).not.toContain("PLAINTEXT-WORKSPACE-TOKEN")
    expect(JSON.stringify(view)).not.toContain("@example.com")
  })

  test("unknown code, expired code and a deleted inviter are all null (no throw)", async () => {
    mocks.findByCode.mockResolvedValueOnce(undefined)
    expect(await findInvitation({ code: "nope" })).toBeNull()

    mocks.findByCode.mockResolvedValueOnce({
      ...invitationRow,
      expiresAt: past,
    })
    expect(await findInvitation({ code: "abc" })).toBeNull()

    mocks.findNameAndEmail.mockResolvedValueOnce(undefined)
    expect(await findInvitation({ code: "abc" })).toBeNull()
  })

  test("a deleted workspace or an invitation without one keeps workspace null", async () => {
    mocks.findWorkspace.mockResolvedValueOnce(undefined)
    expect(await findInvitation({ code: "abc" })).toMatchObject({
      workspace: null,
    })
    mocks.findByCode.mockResolvedValueOnce({
      ...invitationRow,
      workspaceId: null,
    })
    expect(await findInvitation({ code: "abc" })).toMatchObject({
      workspace: null,
    })
    expect(mocks.findWorkspace).toHaveBeenCalledTimes(1)
  })
})

describe("InvitationsPage", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const render = async (code: string) => {
    const page = await InvitationsPage({ params: Promise.resolve({ code }) })
    await act(async () => root.render(page))
  }

  const joinButton = () =>
    [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "actions.joinTheTeam",
    )

  test("an unknown code renders the invalid card with Join disabled", async () => {
    mocks.findByCode.mockResolvedValue(undefined)
    await render("nope")
    expect(container.textContent).toContain("invitation.invalidInvitation")
    expect(joinButton()?.disabled).toBe(true)
  })

  test("a workspace scheduled for deletion says unavailable, Join disabled", async () => {
    mocks.findWorkspace.mockResolvedValue({
      ...workspaceRow,
      scheduledDeletionAt: future,
    })
    await render("abc")
    expect(container.textContent).toContain("invitation.workspaceUnavailable")
    expect(joinButton()?.disabled).toBe(true)
  })

  test("a valid invitation shows the workspace and joins with its code", async () => {
    await render("abc")
    expect(container.textContent).toContain("Acme")
    const join = joinButton()
    expect(join?.disabled).toBe(false)
    act(() => join?.click())
    expect(mocks.execute).toHaveBeenCalledWith({ code: "abc" })
  })
})
