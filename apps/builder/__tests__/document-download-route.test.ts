// @vitest-environment node
import { beforeEach, expect, test, vi } from "vitest"

const resolveDownload = vi.fn()
const getObject = vi.fn()
const loadServableWorkspace = vi.fn()
const logError = vi.fn()

vi.mock("@chatbotx.io/business/documents", () => ({
  documentService: { resolveDownload },
}))
vi.mock("@chatbotx.io/filesystem", () => ({ uploader: { getObject } }))
vi.mock("@/lib/workspace/load-servable-workspace", () => ({
  loadServableWorkspace,
}))
vi.mock("@/lib/log", () => ({ logger: { error: logError } }))

const SAFE_FILENAME_RE = /^[\w-]+\.pdf$/
const TOKEN = "0123456789ABCDEFGHIJKL"
const DOC = { workspaceId: "w1", title: "AfterShock consent – Ada/../x" }
const ctx = (token: string) => ({ params: Promise.resolve({ token }) })
const req = () => new Request(`http://localhost/f/${TOKEN}`)

beforeEach(() => {
  vi.clearAllMocks()
  resolveDownload.mockResolvedValue({
    ok: true,
    document: DOC,
    path: "workspaces/w1/documents/c1/d1.pdf",
  })
  loadServableWorkspace.mockResolvedValue({ servable: true })
  getObject.mockResolvedValue(Buffer.from("%PDF-1.4 x %%EOF"))
})

test("streams the private PDF inline with no-store, nosniff and a safe filename", async () => {
  const { GET } = await import("@/app/f/[token]/route")
  const res = await GET(req(), ctx(TOKEN))
  expect(res.status).toBe(200)
  expect(res.headers.get("content-type")).toBe("application/pdf")
  expect(res.headers.get("cache-control")).toBe("private, no-store")
  expect(res.headers.get("x-content-type-options")).toBe("nosniff")
  expect(res.headers.get("content-disposition")).toBe(
    'inline; filename="AfterShock-consent-Adax.pdf"',
  )
  expect(Buffer.from(await res.arrayBuffer()).toString()).toBe(
    "%PDF-1.4 x %%EOF",
  )
  expect(getObject).toHaveBeenCalledWith("workspaces/w1/documents/c1/d1.pdf")
  expect(resolveDownload).toHaveBeenCalledWith({ token: TOKEN })
})

test("unknown / invalid / no-file -> 404; expired -> 410; workspace being deleted -> 410; storage miss -> 404", async () => {
  const { GET } = await import("@/app/f/[token]/route")
  for (const reason of ["invalid", "not-found", "no-file"]) {
    resolveDownload.mockResolvedValueOnce({ ok: false, reason })
    expect((await GET(req(), ctx(TOKEN))).status).toBe(404)
  }
  resolveDownload.mockResolvedValueOnce({ ok: false, reason: "expired" })
  const expired = await GET(req(), ctx(TOKEN))
  expect(expired.status).toBe(410)
  expect(await expired.json()).toEqual({ code: "linkExpired" })
  loadServableWorkspace.mockResolvedValueOnce({ servable: false })
  expect((await GET(req(), ctx(TOKEN))).status).toBe(410)
  getObject.mockRejectedValueOnce(new Error("NoSuchKey"))
  expect((await GET(req(), ctx(TOKEN))).status).toBe(404)
  expect(logError).toHaveBeenCalled()
  expect(String(logError.mock.calls[0][1])).not.toContain(TOKEN)
})

test("documentFileName never lets quotes, slashes or CRLF through", async () => {
  const { documentFileName } = await import("@/app/f/[token]/route")
  for (const t of ['a"b', "a/b\\c", "x\r\nSet-Cookie: y", "   ", "日本語"]) {
    expect(documentFileName(t)).toMatch(SAFE_FILENAME_RE)
  }
})
