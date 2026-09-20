// @vitest-environment node
import { beforeEach, expect, test, vi } from "vitest"

const findByToken = vi.fn()
const recordVisit = vi.fn()
const markBulktextClick = vi.fn()
const contactInboxFindBy = vi.fn()
const loadServableWorkspace = vi.fn()
const logError = vi.fn()

const TOKEN_LENGTH = 11
const isTrackedLinkToken = (value: unknown) =>
  typeof value === "string" && value.length === TOKEN_LENGTH

vi.mock("@chatbotx.io/business", () => ({
  trackedLinkService: { findByToken, recordVisit },
  markBulktextClick,
  contactInboxService: { findBy: contactInboxFindBy },
  isTrackedLinkToken,
}))

vi.mock("@/lib/workspace/load-servable-workspace", () => ({
  loadServableWorkspace,
}))

vi.mock("@/lib/log", () => ({ logger: { error: logError } }))

const LINK = {
  token: "AbCdEfGhIjK",
  workspaceId: "w1",
  contactId: "c1",
  contactInboxId: "ci1",
  url: "https://example.com/offer",
}
const INBOX = { id: "ci1", inboxId: "in1", channel: "api" }
const HUMAN_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
const PREVIEW_UA = "facebookexternalhit/1.1 Facebot Twitterbot/1.0"

const ctx = (token: string) => ({ params: Promise.resolve({ token }) })
const req = (ua: string, method = "GET") =>
  new Request("http://localhost/l/AbCdEfGhIjK", {
    method,
    headers: { "user-agent": ua },
  })

beforeEach(() => {
  vi.clearAllMocks()
  findByToken.mockResolvedValue(LINK)
  recordVisit.mockResolvedValue(LINK)
  markBulktextClick.mockResolvedValue(undefined)
  contactInboxFindBy.mockResolvedValue(INBOX)
  loadServableWorkspace.mockResolvedValue({ servable: true })
})

const { GET, HEAD } = await import("../src/app/l/[token]/route")

test("a human tap records a click, marks the contact, and redirects 302", async () => {
  const res = await GET(req(HUMAN_UA), ctx(LINK.token))
  expect(res.status).toBe(302)
  expect(res.headers.get("location")).toBe(LINK.url)
  expect(recordVisit).toHaveBeenCalledWith(
    LINK.token,
    "click",
    expect.any(Date),
  )
  expect(markBulktextClick).toHaveBeenCalledWith({
    workspaceId: "w1",
    contactId: "c1",
    contactInbox: INBOX,
    at: expect.any(Date),
  })
})

test("a link preview fetch redirects but only counts a prefetch", async () => {
  const res = await GET(req(PREVIEW_UA), ctx(LINK.token))
  expect(res.status).toBe(302)
  expect(recordVisit).toHaveBeenCalledWith(
    LINK.token,
    "prefetch",
    expect.any(Date),
  )
  expect(markBulktextClick).not.toHaveBeenCalled()
})

test("an unknown or malformed token is a 404 and records nothing", async () => {
  findByToken.mockResolvedValue(undefined)
  expect((await GET(req(HUMAN_UA), ctx(LINK.token))).status).toBe(404)
  expect((await GET(req(HUMAN_UA), ctx("short"))).status).toBe(404)
  expect((await GET(req(HUMAN_UA), ctx("../../etc/passwd"))).status).toBe(404)
  expect(recordVisit).not.toHaveBeenCalled()
  expect(markBulktextClick).not.toHaveBeenCalled()
})

test("a workspace scheduled for deletion is a 410 with nothing recorded", async () => {
  loadServableWorkspace.mockResolvedValue({ servable: false })
  const res = await GET(req(HUMAN_UA), ctx(LINK.token))
  expect(res.status).toBe(410)
  expect(recordVisit).not.toHaveBeenCalled()
})

test("a failed contact mark is logged and the person is still redirected", async () => {
  markBulktextClick.mockRejectedValue(new Error("tag write failed"))
  const res = await GET(req(HUMAN_UA), ctx(LINK.token))
  expect(res.status).toBe(302)
  expect(logError).toHaveBeenCalledOnce()
})

test("a link with no contact inbox still redirects and counts, but marks nothing", async () => {
  findByToken.mockResolvedValue({ ...LINK, contactInboxId: null })
  const res = await GET(req(HUMAN_UA), ctx(LINK.token))
  expect(res.status).toBe(302)
  expect(recordVisit).toHaveBeenCalledOnce()
  expect(contactInboxFindBy).not.toHaveBeenCalled()
  expect(markBulktextClick).not.toHaveBeenCalled()
})

test("HEAD redirects without recording; unknown token is 404", async () => {
  const res = await HEAD(req(HUMAN_UA, "HEAD"), ctx(LINK.token))
  expect(res.status).toBe(302)
  expect(recordVisit).not.toHaveBeenCalled()
  findByToken.mockResolvedValue(undefined)
  expect((await HEAD(req(HUMAN_UA, "HEAD"), ctx(LINK.token))).status).toBe(404)
})
