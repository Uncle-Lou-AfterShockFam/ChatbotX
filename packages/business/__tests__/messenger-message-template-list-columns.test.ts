import { beforeEach, expect, test, vi } from "vitest"

const findMany = vi.fn()

vi.mock("@chatbotx.io/database/client", () => ({
  and: vi.fn(),
  db: {
    $count: vi.fn().mockResolvedValue(0),
    query: {
      messengerMessageTemplateModel: { findMany },
      integrationMessengerModel: { findFirst: vi.fn() },
    },
  },
  eq: vi.fn(),
  ilike: vi.fn(),
  inArray: vi.fn(),
}))

vi.mock("../src/base.service", () => ({ BaseService: class {} }))

const { messengerMessageTemplateService } = await import(
  "../src/messenger-message-template/service"
)

beforeEach(() => {
  vi.clearAllMocks()
  findMany.mockResolvedValue([])
})

// s231a: every template list reaches the browser (templates table,
// conversion events, templates API), so the joined Messenger row must carry
// only an allowlist, never auth / userInfo / capiAccessToken.
test.each([
  [
    "list",
    () => messengerMessageTemplateService.list({ where: { workspaceId: "1" } }),
  ],
  [
    "listPaginated",
    () =>
      messengerMessageTemplateService.listPaginated({
        where: { workspaceId: "1" },
      }),
  ],
])("%s joins only id, name and inboxId of the Messenger row", async (_name, call) => {
  await call()

  const [args] = findMany.mock.calls.at(-1) as [
    { with: { integrationMessenger: unknown } },
  ]
  expect(args.with.integrationMessenger).toEqual({
    columns: { id: true, name: true, inboxId: true },
  })
})
