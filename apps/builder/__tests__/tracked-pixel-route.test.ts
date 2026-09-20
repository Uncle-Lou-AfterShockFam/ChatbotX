// @vitest-environment node
import { beforeEach, expect, test, vi } from "vitest"

const findByToken = vi.fn()
const recordOpen = vi.fn()
const markBulktextOpen = vi.fn()
const contactInboxFindBy = vi.fn()
const loadServableWorkspace = vi.fn()
const logError = vi.fn()

const TOKEN_LENGTH = 11
const isTrackedLinkToken = (value: unknown) =>
  typeof value === "string" && value.length === TOKEN_LENGTH

vi.mock("@chatbotx.io/business", () => ({
  trackedLinkService: { findByToken, recordOpen },
  markBulktextOpen,
  contactInboxService: { findBy: contactInboxFindBy },
  isTrackedLinkToken,
}))
vi.mock("@/lib/workspace/load-servable-workspace", () => ({
  loadServableWorkspace,
}))
vi.mock("@/lib/log", () => ({ logger: { error: logError } }))

const PIXEL = {
  token: "AbCdEfGhIjK",
  kind: "pixel",
  workspaceId: "w1",
  contactId: "c1",
  contactInboxId: "ci1",
  url: "",
}
const INBOX = { id: "ci1", inboxId: "in1", channel: "api" }
const ctx = (token: string) => ({ params: Promise.resolve({ token }) })
const req = (ua = "GoogleImageProxy") =>
  new Request("http://localhost/go/AbCdEfGhIjK/o", {
    headers: { "user-agent": ua },
  })

beforeEach(() => {
  vi.clearAllMocks()
  findByToken.mockResolvedValue(PIXEL)
  recordOpen.mockResolvedValue(PIXEL)
  markBulktextOpen.mockResolvedValue(undefined)
  contactInboxFindBy.mockResolvedValue(INBOX)
  loadServableWorkspace.mockResolvedValue({ servable: true })
})

const { GET } = await import("../src/app/go/[token]/o/route")

test("a fetch of the beacon answers a no-store 1x1 GIF, records the open and marks the contact (proxy fetchers count)", async () => {
  const res = await GET(req(), ctx(PIXEL.token))
  expect(res.status).toBe(200)
  expect(res.headers.get("content-type")).toBe("image/gif")
  expect(res.headers.get("cache-control")).toContain("no-store")
  expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(20)
  expect(recordOpen).toHaveBeenCalledWith(PIXEL.token, expect.any(Date))
  expect(markBulktextOpen).toHaveBeenCalledWith({
    workspaceId: "w1",
    contactId: "c1",
    contactInbox: INBOX,
    at: expect.any(Date),
  })
})

test("a link token, an unknown token and a malformed token are 404 with nothing recorded", async () => {
  findByToken.mockResolvedValue({ ...PIXEL, kind: "link", url: "https://x.y" })
  expect((await GET(req(), ctx(PIXEL.token))).status).toBe(404)
  findByToken.mockResolvedValue(undefined)
  expect((await GET(req(), ctx(PIXEL.token))).status).toBe(404)
  expect((await GET(req(), ctx("nope"))).status).toBe(404)
  expect(recordOpen).not.toHaveBeenCalled()
  expect(markBulktextOpen).not.toHaveBeenCalled()
})

test("a frozen workspace is 410; a failed contact mark still answers the GIF", async () => {
  loadServableWorkspace.mockResolvedValue({ servable: false })
  expect((await GET(req(), ctx(PIXEL.token))).status).toBe(410)
  expect(recordOpen).not.toHaveBeenCalled()
  loadServableWorkspace.mockResolvedValue({ servable: true })
  markBulktextOpen.mockRejectedValue(new Error("tag write failed"))
  const res = await GET(req(), ctx(PIXEL.token))
  expect(res.status).toBe(200)
  expect(logError).toHaveBeenCalledOnce()
})
