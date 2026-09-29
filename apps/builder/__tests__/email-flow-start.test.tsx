// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from "vitest"

const m = vi.hoisted(() => ({
  verify: vi.fn(),
  loadServable: vi.fn(),
  findContactInbox: vi.fn(),
  findFlow: vi.fn(),
  createOutgoing: vi.fn(),
  findAnalyticsWorkspace: vi.fn(),
  recordClick: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
  evalScript: vi.fn(),
  findConversation: vi.fn(),
  warn: vi.fn(),
}))

vi.mock("@chatbotx.io/business", () => ({
  verifyEmailFlowToken: m.verify,
  contactInboxService: { findInWorkspace: m.findContactInbox },
  flowService: { findActiveById: m.findFlow },
  conversationService: { findByContactWithInboxes: m.findConversation },
  messageService: { createOutgoing: m.createOutgoing },
  emailTopicService: {
    findAnalyticsWorkspaceIdByToken: m.findAnalyticsWorkspace,
  },
}))
vi.mock("@chatbotx.io/analytics", () => ({
  emailTopicAnalyticsService: { recordClick: m.recordClick },
}))
vi.mock("@chatbotx.io/redis", () => ({
  cacheConnections: {
    useExisting: async () => ({ get: m.get, set: m.set, eval: m.evalScript }),
  },
}))
vi.mock("@/lib/workspace/load-servable-workspace", () => ({
  loadServableWorkspace: m.loadServable,
}))
vi.mock("@/lib/log", () => ({
  logger: { warn: m.warn, error: vi.fn() },
}))
vi.mock("next-intl/server", () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}))

const route = await import("../src/app/email-topic/flow/start/route")
const { default: EmailFlowPage } = await import(
  "../src/app/email-topic/flow/page"
)

const ORIGIN = "https://hub.test"
const LINK = "5b4b4a52-4c4e-4d52-9a2b-1c2d3e4f5a6b"
const UUID = /^[0-9a-f-]{36}$/
const PAYLOAD = { wid: "1", fid: "700", cid: "9", ciid: "90", lid: LINK }
const CONTACT_INBOX = { id: "90", inboxId: "55" }

function post(body: Record<string, string> | null, query = "t=tok&r=rec") {
  const init: RequestInit = { method: "POST" }
  if (body) {
    init.body = new URLSearchParams(body)
    init.headers = { "content-type": "application/x-www-form-urlencoded" }
  }
  return new Request(`${ORIGIN}/email-topic/flow/start?${query}`, init)
}

beforeEach(() => {
  vi.clearAllMocks()
  m.verify.mockResolvedValue(PAYLOAD)
  m.loadServable.mockResolvedValue({ servable: true })
  m.findContactInbox.mockResolvedValue(CONTACT_INBOX)
  m.findFlow.mockResolvedValue({ id: "700", currentVersionId: "7001" })
  m.findConversation.mockResolvedValue({ id: "conv" })
  m.createOutgoing.mockResolvedValue(null)
  m.findAnalyticsWorkspace.mockResolvedValue("1")
  m.get.mockResolvedValue(null)
  m.set.mockResolvedValue("OK")
})

describe("POST /email-topic/flow/start (s222b)", () => {
  test("the confirm form starts the sealed flow for the sealed contact on its inbox, counts the click, and 303s back", async () => {
    const res = await route.POST(post({ source: "page" }))
    expect(res.status).toBe(303)
    const location = new URL(res.headers.get("location") ?? "", ORIGIN)
    expect(location.pathname).toBe("/email-topic/flow")
    expect(location.searchParams.get("result")).toBe("started")
    expect(location.searchParams.get("r")).toBe("rec")
    expect(m.findContactInbox).toHaveBeenCalledWith({
      id: "90",
      contactId: "9",
      workspaceId: "1",
    })
    expect(m.findFlow).toHaveBeenCalledWith({ workspaceId: "1", id: "700" })
    // The SEALED contact inbox runs the flow, never a re-selected one.
    expect(m.createOutgoing).toHaveBeenCalledWith({
      conversation: { id: "conv" },
      contactInbox: CONTACT_INBOX,
      // The enqueue is idempotent on the sealed link id.
      input: {
        flowId: "700",
        inboxId: "55",
        jobId: `email-flow-start:${LINK}`,
      },
    })
    expect(m.recordClick).toHaveBeenCalledWith("rec")
    // Claimed by the sealed LINK id with an owner nonce, then queued for a year.
    const [claim, promote] = m.set.mock.calls
    expect(claim).toEqual([
      `email-flow:start:${LINK}`,
      expect.stringMatching(UUID),
      "EX",
      300,
      "NX",
    ])
    expect(promote).toEqual([
      `email-flow:start:${LINK}`,
      "queued",
      "EX",
      366 * 24 * 60 * 60,
    ])
  })

  test("a node-scoped token starts at that node", async () => {
    m.verify.mockResolvedValue({ ...PAYLOAD, nid: "703" })
    await route.POST(post({ source: "page" }))
    expect(m.createOutgoing).toHaveBeenCalledWith(
      expect.objectContaining({
        input: {
          flowId: "700",
          nodeId: "703",
          inboxId: "55",
          jobId: `email-flow-start:${LINK}`,
        },
      }),
    )
  })

  test("a second POST of the same link never starts the flow twice (atomic claim)", async () => {
    m.set.mockResolvedValue(null)
    const res = await route.POST(post({ source: "page" }))
    expect(res.status).toBe(303)
    expect(m.createOutgoing).not.toHaveBeenCalled()
    expect(m.recordClick).not.toHaveBeenCalled()
  })

  test("a failed start releases ONLY its own claim (compare-and-delete on the nonce) and surfaces the error", async () => {
    m.createOutgoing.mockRejectedValue(new Error("queue down"))
    await expect(route.POST(post({ source: "page" }))).rejects.toThrow(
      "queue down",
    )
    const owner = m.set.mock.calls[0][1]
    expect(m.evalScript).toHaveBeenCalledWith(
      expect.stringContaining('redis.call("get", KEYS[1]) == ARGV[1]'),
      1,
      `email-flow:start:${LINK}`,
      owner,
    )
  })

  test("once queued, failed bookkeeping (promote, click count) never turns the answer into an error", async () => {
    m.set.mockResolvedValueOnce("OK").mockRejectedValueOnce(new Error("redis"))
    const res = await route.POST(post({ source: "page" }))
    expect(res.status).toBe(303)
    expect(m.createOutgoing).toHaveBeenCalledOnce()
    expect(m.warn).toHaveBeenCalledOnce()
    m.set.mockResolvedValue("OK")
    m.recordClick.mockRejectedValueOnce(new Error("pg"))
    expect((await route.POST(post({ source: "page" }))).status).toBe(303)
  })

  test("a recipient token of ANOTHER workspace is not counted", async () => {
    m.findAnalyticsWorkspace.mockResolvedValue("2")
    await route.POST(post({ source: "page" }))
    expect(m.createOutgoing).toHaveBeenCalledOnce()
    expect(m.recordClick).not.toHaveBeenCalled()
  })

  test("a bad token, a foreign contact inbox, a foreign flow or an unservable workspace starts nothing", async () => {
    const cases: [() => void, string][] = [
      [() => m.verify.mockRejectedValueOnce(new Error("bad")), "invalid"],
      [() => m.findContactInbox.mockResolvedValueOnce(undefined), "invalid"],
      [() => m.findFlow.mockResolvedValueOnce(undefined), "invalid"],
      [
        () =>
          m.findFlow.mockResolvedValueOnce({
            id: "700",
            currentVersionId: null,
          }),
        "invalid",
      ],
      [
        () => m.loadServable.mockResolvedValueOnce({ servable: false }),
        "unavailable",
      ],
    ]
    for (const [arrange, result] of cases) {
      arrange()
      const res = await route.POST(post({ source: "page" }))
      const location = new URL(res.headers.get("location") ?? "", ORIGIN)
      expect(location.searchParams.get("result")).toBe(result)
    }
    expect(m.set).not.toHaveBeenCalled()
    expect(m.createOutgoing).not.toHaveBeenCalled()
  })

  test("no form, a wrong form, or an oversized body is refused before any token work", async () => {
    expect((await route.POST(post(null))).status).toBe(400)
    expect((await route.POST(post({ foo: "bar" }))).status).toBe(400)
    const big = new Request(`${ORIGIN}/email-topic/flow/start?t=tok`, {
      method: "POST",
      body: "x".repeat(2000),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "content-length": "2000",
      },
    })
    expect((await route.POST(big)).status).toBe(413)
    // No Content-Length (chunked): the cap is on the bytes actually read.
    const chunked = new Request(`${ORIGIN}/email-topic/flow/start?t=tok`, {
      method: "POST",
      body: new ReadableStream({
        start(controller) {
          for (let i = 0; i < 4; i++) {
            controller.enqueue(new TextEncoder().encode("x".repeat(500)))
          }
          controller.close()
        },
      }),
      // @ts-expect-error Node's fetch needs duplex for a stream body
      duplex: "half",
    })
    expect(chunked.headers.get("content-length")).toBeNull()
    expect((await route.POST(chunked)).status).toBe(413)
    expect(m.verify).not.toHaveBeenCalled()
  })

  test("GET is not handled: a link scanner can never start a flow", () => {
    expect("GET" in route).toBe(false)
  })
})

describe("/email-topic/flow page (s222b)", () => {
  test("a valid token renders the confirm form (posting t and r) and never starts anything", async () => {
    const page = await EmailFlowPage({
      searchParams: Promise.resolve({ t: "tok", r: "rec" }),
    })
    const html = JSON.stringify(page)
    expect(html).toContain("confirmTitle")
    expect(html).toContain("/email-topic/flow/start?t=tok&r=rec")
    expect(m.createOutgoing).not.toHaveBeenCalled()
    expect(m.set).not.toHaveBeenCalled()
  })

  test("started shows exactly when the link's claim exists (pending or queued), whatever the URL says", async () => {
    const unclaimed = await EmailFlowPage({
      searchParams: Promise.resolve({ t: "tok", result: "started" } as never),
    })
    expect(JSON.stringify(unclaimed)).toContain("confirmTitle")
    for (const value of ["queued", "some-owner-nonce"]) {
      m.get.mockResolvedValue(value)
      const reopened = await EmailFlowPage({
        searchParams: Promise.resolve({ t: "tok" }),
      })
      expect(JSON.stringify(reopened)).toContain("startedTitle")
    }
  })

  test("the claim store down renders the unavailable page, never a 500", async () => {
    m.get.mockRejectedValue(new Error("ECONNREFUSED"))
    const page = await EmailFlowPage({
      searchParams: Promise.resolve({ t: "tok" }),
    })
    expect(JSON.stringify(page)).toContain("unavailableTitle")
  })

  test("a missing or bad token is the invalid page; an unservable workspace the unavailable page", async () => {
    expect(
      JSON.stringify(
        await EmailFlowPage({ searchParams: Promise.resolve({}) }),
      ),
    ).toContain("invalidTitle")
    m.loadServable.mockResolvedValue({ servable: false })
    expect(
      JSON.stringify(
        await EmailFlowPage({ searchParams: Promise.resolve({ t: "tok" }) }),
      ),
    ).toContain("unavailableTitle")
  })
})
