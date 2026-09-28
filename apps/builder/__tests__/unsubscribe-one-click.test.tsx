// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from "vitest"

const { mockUnsubscribeEmail, mockVerify, mockLoadServable, mockFindById } =
  vi.hoisted(() => ({
    mockUnsubscribeEmail: vi.fn(),
    mockVerify: vi.fn(),
    mockLoadServable: vi.fn(),
    mockFindById: vi.fn(),
  }))

vi.mock("@chatbotx.io/business", () => ({
  contactService: {
    unsubscribeEmail: mockUnsubscribeEmail,
    findById: mockFindById,
  },
  verifyUnsubscribeToken: mockVerify,
}))
vi.mock("@/lib/workspace/load-servable-workspace", () => ({
  loadServableWorkspace: mockLoadServable,
}))
vi.mock("next-intl/server", () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}))

const route = await import("../src/app/unsubscribe/one-click/route")
const { default: UnsubscribePage } = await import("../src/app/unsubscribe/page")

const ORIGIN = "https://hub.test"

function post(body: Record<string, string> | null, token = "tok") {
  const init: RequestInit = { method: "POST" }
  if (body) {
    init.body = new URLSearchParams(body)
    init.headers = { "content-type": "application/x-www-form-urlencoded" }
  }
  return new Request(
    `${ORIGIN}/unsubscribe/one-click?token=${encodeURIComponent(token)}`,
    init,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockVerify.mockResolvedValue({ cid: "c-1", wid: "ws-1" })
  mockLoadServable.mockResolvedValue({ servable: true })
  mockUnsubscribeEmail.mockResolvedValue(undefined)
  mockFindById.mockResolvedValue({ id: "c-1", emailOptIn: true })
})

describe("POST /unsubscribe/one-click", () => {
  test("RFC 8058 one-click body unsubscribes and answers 200", async () => {
    const res = await route.POST(post({ "List-Unsubscribe": "One-Click" }))
    expect(res.status).toBe(200)
    expect(mockUnsubscribeEmail).toHaveBeenCalledWith("c-1")
  })

  test("the confirm form redirects back to the page result (303)", async () => {
    const res = await route.POST(post({ source: "page" }))
    expect(res.status).toBe(303)
    const location = new URL(res.headers.get("location") ?? "")
    expect(location.pathname).toBe("/unsubscribe")
    expect(location.searchParams.get("result")).toBe("done")
    expect(mockUnsubscribeEmail).toHaveBeenCalledOnce()
  })

  test("no body, or an unknown body, is refused without acting", async () => {
    expect((await route.POST(post(null))).status).toBe(400)
    expect((await route.POST(post({ foo: "bar" }))).status).toBe(400)
    expect(mockUnsubscribeEmail).not.toHaveBeenCalled()
  })

  test("a bad token is 400 and never mutates", async () => {
    mockVerify.mockRejectedValue(new Error("bad"))
    const res = await route.POST(post({ "List-Unsubscribe": "One-Click" }))
    expect(res.status).toBe(400)
    expect(mockUnsubscribeEmail).not.toHaveBeenCalled()
  })

  test("an empty or oversized token is refused before verify", async () => {
    await route.POST(post({ "List-Unsubscribe": "One-Click" }, ""))
    await route.POST(
      post({ "List-Unsubscribe": "One-Click" }, "x".repeat(5000)),
    )
    expect(mockVerify).not.toHaveBeenCalled()
    expect(mockUnsubscribeEmail).not.toHaveBeenCalled()
  })

  test("a workspace scheduled for deletion is 410 and never mutates", async () => {
    mockLoadServable.mockResolvedValue({ servable: false })
    const res = await route.POST(post({ "List-Unsubscribe": "One-Click" }))
    expect(res.status).toBe(410)
    expect(mockUnsubscribeEmail).not.toHaveBeenCalled()
  })

  test("GET is not handled (a link scanner cannot unsubscribe)", () => {
    expect("GET" in route).toBe(false)
  })
})

describe("/unsubscribe page", () => {
  test("a valid token renders the confirm form and never mutates", async () => {
    const page = await UnsubscribePage({
      searchParams: Promise.resolve({ token: "tok" }),
    })
    const html = JSON.stringify(page)
    expect(html).toContain("confirmTitle")
    expect(html).toContain("/unsubscribe/one-click?token=tok")
    expect(mockUnsubscribeEmail).not.toHaveBeenCalled()
  })

  test("result=done shows success only for a verified, opted-out contact", async () => {
    mockFindById.mockResolvedValue({ id: "c-1", emailOptIn: false })
    const page = await UnsubscribePage({
      searchParams: Promise.resolve({ token: "tok", result: "done" }),
    })
    const html = JSON.stringify(page)
    expect(html).toContain('"title"')
    expect(html).not.toContain("confirmTitle")
    expect(mockUnsubscribeEmail).not.toHaveBeenCalled()
  })

  test("a forged result=done for a still-subscribed contact shows the confirm form", async () => {
    const page = await UnsubscribePage({
      searchParams: Promise.resolve({ token: "tok", result: "done" }),
    })
    expect(JSON.stringify(page)).toContain("confirmTitle")
  })

  test("result=done without a valid token is the invalid page", async () => {
    const page = await UnsubscribePage({
      searchParams: Promise.resolve({ result: "done" }),
    })
    expect(JSON.stringify(page)).toContain("invalidTitle")
  })

  test("result=unavailable cannot hide the confirm form for a valid token", async () => {
    const page = await UnsubscribePage({
      searchParams: Promise.resolve({ token: "tok", result: "unavailable" }),
    })
    expect(JSON.stringify(page)).toContain("confirmTitle")
  })

  test("a missing or bad token renders the invalid copy", async () => {
    mockVerify.mockRejectedValue(new Error("bad"))
    const page = await UnsubscribePage({
      searchParams: Promise.resolve({ token: "tok" }),
    })
    expect(JSON.stringify(page)).toContain("invalidTitle")
    const missing = await UnsubscribePage({
      searchParams: Promise.resolve({}),
    })
    expect(JSON.stringify(missing)).toContain("invalidTitle")
  })
})
