// @vitest-environment node

import { Readable } from "node:stream"
import { beforeEach, describe, expect, test, vi } from "vitest"

/**
 * A submitted web upload (s225a A2-4 PR 5) is served only to a member who
 * may open the contacts section, only when claimed by that workspace's
 * form, always as a download with the SNIFFED type; every other request is
 * the same bare 404.
 */
const m = vi.hoisted(() => ({
  member: vi.fn(),
  canAccess: vi.fn(() => true),
  findClaimed: vi.fn(),
  getObjectStream: vi.fn(),
}))
vi.mock("@/lib/auth/utils", () => ({
  getCurrentUserAndTargetWorkspace: m.member,
}))
vi.mock("@/features/contacts/permissions", () => ({
  canAccessContactsSection: m.canAccess,
}))
vi.mock("@chatbotx.io/business/form", () => ({
  formUploadService: { findClaimed: m.findClaimed },
}))
vi.mock("@chatbotx.io/filesystem", () => ({
  uploader: { getObjectStream: m.getObjectStream },
}))
vi.mock("@/lib/log", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}))

const { GET, uploadContentDisposition } = await import(
  "../src/app/space/[workspaceId]/forms/[id]/uploads/[uploadId]/route"
)

const ATTACHMENT = /^attachment; /
const LINE_BREAK = /[\r\n]/
const WS = "11701868563365888"
const FORM = "11716310095904768"
const UP = `fu_${"b".repeat(43)}`
const get = (ws = WS, form = FORM, uploadId = UP) =>
  GET(new Request("https://chat.example/x"), {
    params: Promise.resolve({ workspaceId: ws, id: form, uploadId }),
  })

beforeEach(() => {
  vi.clearAllMocks()
  m.member.mockResolvedValue({ targetWorkspaceMember: { permissions: {} } })
  m.canAccess.mockReturnValue(true)
  m.findClaimed.mockResolvedValue({
    id: "1",
    formId: FORM,
    path: `workspaces/${WS}/forms/${FORM}/uuid`,
    mimeType: "image/png",
    sizeBytes: 3,
    fileName: "résumé <x>.png",
  })
  m.getObjectStream.mockResolvedValue({
    stream: Readable.from([Buffer.from([1, 2, 3])]),
  })
})

describe("GET /space/{ws}/forms/{id}/uploads/{uploadId}", () => {
  test("a member gets the bytes as an attachment with the stored, sniffed type", async () => {
    const res = await get()
    expect(res.status).toBe(200)
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    )
    expect(res.headers.get("content-type")).toBe("image/png")
    expect(res.headers.get("x-content-type-options")).toBe("nosniff")
    expect(res.headers.get("content-security-policy")).toContain("sandbox")
    expect(res.headers.get("cache-control")).toBe("private, no-store")
    expect(res.headers.get("content-disposition")).toMatch(ATTACHMENT)
    expect(m.findClaimed).toHaveBeenCalledWith({
      workspaceId: WS,
      formId: FORM,
      uploadId: UP,
    })
  })

  test("signed out, not a member, no contacts access, not claimed, bad ids, missing object -> the same bare 404", async () => {
    m.member.mockResolvedValueOnce(null)
    expect((await get()).status).toBe(404)
    m.canAccess.mockReturnValueOnce(false)
    expect((await get()).status).toBe(404)
    m.findClaimed.mockResolvedValueOnce(null)
    expect((await get()).status).toBe(404)
    expect((await get("x", FORM)).status).toBe(404)
    expect((await get(WS, "1; drop")).status).toBe(404)
    m.getObjectStream.mockRejectedValueOnce(new Error("NoSuchKey"))
    const missing = await get()
    expect(missing.status).toBe(404)
    expect(await missing.text()).toBe("")
  })

  test("the member check runs before any lookup", async () => {
    m.member.mockResolvedValueOnce(null)
    await get()
    expect(m.findClaimed).not.toHaveBeenCalled()
    expect(m.getObjectStream).not.toHaveBeenCalled()
  })

  test("Content-Disposition carries a safe ASCII name plus the UTF-8 one, never a raw quote or newline", () => {
    const h = uploadContentDisposition('a"b\r\nc résumé.pdf')
    expect(h).not.toMatch(LINE_BREAK)
    expect(h.split('"').length).toBe(3)
    expect(h).toContain("filename*=UTF-8''")
    expect(uploadContentDisposition("...")).toContain('filename="upload"')
  })
})
