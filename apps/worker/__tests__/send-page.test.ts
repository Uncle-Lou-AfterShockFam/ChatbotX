import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  mintLink: vi.fn(),
  resolveTenantSettings: vi.fn(),
  resolveByNameAndType: vi.fn(),
  setValueByKey: vi.fn(),
}))

vi.mock("@chatbotx.io/business", () => ({
  resolveTenantSettings: mocks.resolveTenantSettings,
  customFieldService: { resolveByNameAndType: mocks.resolveByNameAndType },
  contactCustomFieldService: { setValueByKey: mocks.setValueByKey },
}))
vi.mock("@chatbotx.io/business/page", () => ({
  PAGE_LINK_FIELD: "page_link",
  pageLinkUrl: (appUrl: string, token: string) =>
    new URL(`/p/${token}`, appUrl).toString(),
  pageService: { mintLink: mocks.mintLink },
}))
vi.mock("../src/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn() },
}))

const { handleSendPage, pageLinkRef } = await import(
  "../src/integration/handlers/send-page"
)

const PAGE_REF = /^page:[0-9a-f]{40}$/
type Props = Parameters<typeof handleSendPage>[0]
const props = (step: Record<string, unknown> = {}, over: Partial<Props> = {}) =>
  ({
    conversation: { id: "conv-1", workspaceId: "w1", contactId: "c1" },
    contactInbox: { id: "ci-1", inboxId: "in-1", channel: "api" },
    step: {
      id: "step-1",
      stepType: "sendPage",
      pageId: "p1",
      states: [],
      ...step,
    },
    flowExecutionKey: "flow-run-1",
    ...over,
  }) as unknown as Props

beforeEach(() => {
  vi.clearAllMocks()
  mocks.mintLink.mockResolvedValue({
    id: "l1",
    token: "0123456789ABCDEFGHIJKL",
    expiresAt: new Date("2026-10-07T12:00:00Z"),
  })
  mocks.resolveTenantSettings.mockResolvedValue({
    appUrl: "https://chat.example",
  })
  mocks.resolveByNameAndType.mockResolvedValue({
    idMap: new Map([["shortText:page_link", "333"]]),
  })
  mocks.setValueByKey.mockResolvedValue(undefined)
})

describe("pageLinkRef", () => {
  test("stable per (run, step), ref-safe, distinct across runs and steps", () => {
    const a = pageLinkRef("flow-run-1", "step-1")
    expect(a).toBe(pageLinkRef("flow-run-1", "step-1"))
    expect(a).toMatch(PAGE_REF)
    expect(a).not.toBe(pageLinkRef("flow-run-2", "step-1"))
    expect(a).not.toBe(pageLinkRef("flow-run-1", "step-2"))
  })
})

describe("handleSendPage (s227a)", () => {
  test("mints this contact's link once per run+step and writes its URL to page_link", async () => {
    const result = await handleSendPage(props({ ttlHours: 24 }))
    expect(result).toEqual({
      status: "success",
      result: { pageLinkId: "l1", expiresAt: "2026-10-07T12:00:00.000Z" },
    })
    expect(mocks.mintLink).toHaveBeenCalledWith({
      workspaceId: "w1",
      pageId: "p1",
      contactId: "c1",
      contactInboxId: "ci-1",
      ttlHours: 24,
      ref: pageLinkRef("flow-run-1", "step-1"),
    })
    expect(mocks.setValueByKey).toHaveBeenCalledWith({
      workspaceId: "w1",
      contactId: "c1",
      keyword: "333",
      value: "https://chat.example/p/0123456789ABCDEFGHIJKL",
      contactInboxId: "ci-1",
    })
  })

  test("no page picked or no run key is an error before anything is minted", async () => {
    for (const p of [
      props({ pageId: undefined }),
      props({}, { flowExecutionKey: undefined }),
    ]) {
      const result = await handleSendPage(p)
      expect(result.status).toBe("error")
    }
    expect(mocks.mintLink).not.toHaveBeenCalled()
    expect(mocks.setValueByKey).not.toHaveBeenCalled()
  })

  test("an archived / foreign page or a failed field write is the error state, never a throw", async () => {
    mocks.mintLink.mockRejectedValueOnce(new Error("The page is archived"))
    expect(await handleSendPage(props())).toMatchObject({
      status: "error",
      errorMessage: "The page is archived",
    })
    expect(mocks.setValueByKey).not.toHaveBeenCalled()
    mocks.setValueByKey.mockRejectedValueOnce(new Error("db down"))
    expect(await handleSendPage(props())).toMatchObject({ status: "error" })
  })
})
