// @vitest-environment node

import { NextRequest } from "next/server"
import { beforeEach, describe, expect, test, vi } from "vitest"

/**
 * The web form upload route (s225a A2-4 PR 5): the start route's gate order
 * (per-ip limit before any lookup), its OWN budget, a closed query, a body
 * read capped at the FIELD's limit, and every refusal before the service.
 */
const m = vi.hoisted(() => ({
  servable: vi.fn(async () => ({ servable: true, workspace: {} })),
  workspaceFind: vi.fn(async () => ({ id: "ws", deletionScheduledAt: null })),
  scheduled: vi.fn(() => false),
  findPublishedBySlug: vi.fn(),
  store: vi.fn(),
  ipLimit: vi.fn(async () => ({ limited: false, retryAfter: 30 })),
  formLimit: vi.fn(async () => ({ limited: false, retryAfter: 30 })),
}))
vi.mock("@/lib/workspace/load-servable-workspace", () => ({
  loadServableWorkspace: m.servable,
}))
vi.mock("@chatbotx.io/business", () => ({
  workspaceService: { find: m.workspaceFind },
  isWorkspaceScheduledForDeletion: m.scheduled,
}))
vi.mock("@chatbotx.io/business/form", async () => {
  const { formInputFields } = await import("@chatbotx.io/utils/form")
  return {
    formService: { findPublishedBySlug: m.findPublishedBySlug },
    formUploadService: { store: m.store },
    formUploadField: (def: never, key: unknown) =>
      formInputFields(def).find(
        (f) => f.key === key && (f.type === "image" || f.type === "file"),
      ) ?? null,
  }
})
vi.mock("@/lib/rate-limit/form-rate-limit", () => ({
  checkFormUploadIpRateLimit: m.ipLimit,
  checkFormUploadFormRateLimit: m.formLimit,
}))
vi.mock("@/lib/rate-limit/guest-rate-limit", () => ({
  getGuestClientIp: () => "203.0.113.9",
}))
vi.mock("@/lib/log", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}))

const { POST, uploadFormQuery, MAX_UPLOADS_IN_FLIGHT } = await import(
  "../src/app/api/forms/[workspaceId]/[slug]/upload/route"
)

const WS = "11701868563365888"
const V = "8f14e45f-ceea-4e67-a3b1-2c9e1d0a7b6f"
const DEF = {
  steps: [
    {
      id: "s1",
      fields: [
        { key: "note", type: "text", label: "", required: false },
        { key: "photo", type: "image", label: "", required: false },
        { key: "doc", type: "file", label: "", required: false, maxSizeMb: 1 },
      ],
    },
  ],
  rules: [],
}
const FORM = {
  id: "form-1",
  settings: { embedOrigins: ["https://host.example"] },
  publishedDefinition: DEF,
}
const params = (slug = "demo-intake", workspaceId = WS) => ({
  params: Promise.resolve({ workspaceId, slug }),
})
const post = (
  query: Record<string, string>,
  body: Uint8Array<ArrayBuffer> = new Uint8Array([1, 2, 3]),
  headers: Record<string, string> = {},
  slug?: string,
) =>
  POST(
    new NextRequest(
      `https://chat.example/api/forms/${WS}/demo-intake/upload?${new URLSearchParams(query)}`,
      {
        method: "POST",
        headers: { "content-type": "application/octet-stream", ...headers },
        body,
      },
    ),
    params(slug),
  )

beforeEach(() => {
  vi.clearAllMocks()
  m.servable.mockResolvedValue({ servable: true, workspace: {} })
  m.scheduled.mockReturnValue(false)
  m.findPublishedBySlug.mockResolvedValue(FORM)
  m.ipLimit.mockResolvedValue({ limited: false, retryAfter: 30 })
  m.formLimit.mockResolvedValue({ limited: false, retryAfter: 30 })
  m.store.mockResolvedValue({
    kind: "ok",
    uploadId: `fu_${"a".repeat(43)}`,
    fileName: "me.png",
    sizeBytes: 3,
  })
})

describe("POST /api/forms/{ws}/{slug}/upload", () => {
  test("a good upload hands the form, field, page load, ip, bytes and name to the service", async () => {
    const res = await post({ field: "photo", v: V, name: "me.png" })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      uploadId: `fu_${"a".repeat(43)}`,
      name: "me.png",
      size: 3,
    })
    expect(m.store).toHaveBeenCalledWith({
      form: FORM,
      fieldKey: "photo",
      interactionId: V,
      clientIp: "203.0.113.9",
      bytes: new Uint8Array([1, 2, 3]),
      fileName: "me.png",
    })
  })

  test("per-ip limit runs BEFORE any lookup", async () => {
    m.ipLimit.mockResolvedValueOnce({ limited: true, retryAfter: 4.1 })
    const res = await post({ field: "photo", v: V }, undefined, {}, "nope")
    expect(res.status).toBe(429)
    expect(res.headers.get("retry-after")).toBe("5")
    expect(m.servable).not.toHaveBeenCalled()
    expect(m.findPublishedBySlug).not.toHaveBeenCalled()
    expect(m.store).not.toHaveBeenCalled()
  })

  test("per-form limit after the form resolved", async () => {
    m.formLimit.mockResolvedValueOnce({ limited: true, retryAfter: 5 })
    expect((await post({ field: "photo", v: V })).status).toBe(429)
    expect(m.formLimit).toHaveBeenCalledWith({ formId: "form-1" })
    expect(m.store).not.toHaveBeenCalled()
  })

  test("bad query: unknown key, bad v, a non-upload field, an unknown field -> 400, no store", async () => {
    expect((await post({ field: "photo", v: V, x: "1" })).status).toBe(400)
    expect((await post({ field: "photo", v: "nope" })).status).toBe(400)
    expect((await post({ field: "photo" })).status).toBe(400)
    expect((await post({ field: "note", v: V })).status).toBe(400)
    expect((await post({ field: "__proto__", v: V })).status).toBe(400)
    expect(
      (await post({ field: "photo", v: V, name: "n".repeat(256) })).status,
    ).toBe(400)
    expect(m.store).not.toHaveBeenCalled()
  })

  test("the body is capped at the FIELD's limit (1 MB doc), and a declared length past 10 MiB is refused up front", async () => {
    const res = await post(
      { field: "doc", v: V },
      new Uint8Array(1024 * 1024 + 1),
    )
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({
      ok: false,
      errors: [{ key: "doc", code: "uploadSize" }],
    })
    const declared = await post({ field: "photo", v: V }, undefined, {
      "content-length": String(10 * 1024 * 1024 + 1),
    })
    expect(declared.status).toBe(413)
    expect(m.servable).toHaveBeenCalledTimes(1)
    expect(m.store).not.toHaveBeenCalled()
  })

  test("service refusals map to 400 / 413 / 429", async () => {
    m.store.mockResolvedValueOnce({ kind: "invalid", code: "uploadType" })
    const type = await post({ field: "photo", v: V })
    expect(type.status).toBe(400)
    expect(await type.json()).toEqual({
      ok: false,
      errors: [{ key: "photo", code: "uploadType" }],
    })
    m.store.mockResolvedValueOnce({ kind: "invalid", code: "uploadSize" })
    expect((await post({ field: "photo", v: V })).status).toBe(413)
    m.store.mockResolvedValueOnce({ kind: "rateLimited" })
    expect((await post({ field: "photo", v: V })).status).toBe(429)
    m.store.mockResolvedValueOnce({ kind: "gone" })
    expect((await post({ field: "photo", v: V })).status).toBe(404)
  })

  test("bodies in flight are capped: the next upload is a 429 before it reads, and slots free up (Codex probe s225a)", async () => {
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = []
    const slow = () =>
      POST(
        new NextRequest(
          `https://chat.example/api/forms/${WS}/demo-intake/upload?field=photo&v=${V}`,
          {
            method: "POST",
            body: new ReadableStream<Uint8Array>({
              start: (c) => {
                controllers.push(c)
                c.enqueue(new Uint8Array([1]))
              },
            }),
            duplex: "half",
          } as ConstructorParameters<typeof NextRequest>[1] & {
            duplex: "half"
          },
        ),
        params(),
      )
    const pending = Array.from({ length: MAX_UPLOADS_IN_FLIGHT }, slow)
    await vi.waitFor(() =>
      expect(controllers).toHaveLength(MAX_UPLOADS_IN_FLIGHT),
    )
    const refused = await post({ field: "photo", v: V })
    expect(refused.status).toBe(429)
    expect(refused.headers.get("retry-after")).toBe("5")
    for (const c of controllers) {
      c.close()
    }
    expect((await Promise.all(pending)).map((r) => r.status)).toEqual(
      new Array(MAX_UPLOADS_IN_FLIGHT).fill(200),
    )
    expect((await post({ field: "photo", v: V })).status).toBe(200)
  })

  test("CORS: a stranger origin is 403 before any store", async () => {
    const res = await post({ field: "photo", v: V }, undefined, {
      origin: "https://evil.example",
    })
    expect(res.status).toBe(403)
    expect(m.store).not.toHaveBeenCalled()
  })

  test("a thrown error is a bare 500, never its message", async () => {
    m.store.mockRejectedValueOnce(new Error("s3 secret host"))
    const res = await post({ field: "photo", v: V })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ ok: false, errors: [] })
  })

  test("uploadFormQuery is closed and fuzz-safe", () => {
    for (let i = 0; i < 200; i++) {
      const junk = { field: "photo", v: V, [`k${i}`]: String(i) }
      expect(uploadFormQuery.safeParse(junk).success).toBe(false)
    }
    for (const j of [null, 1, [], { field: 1, v: V }, { v: V }]) {
      expect(() => uploadFormQuery.safeParse(j)).not.toThrow()
      expect(uploadFormQuery.safeParse(j).success).toBe(false)
    }
  })
})
