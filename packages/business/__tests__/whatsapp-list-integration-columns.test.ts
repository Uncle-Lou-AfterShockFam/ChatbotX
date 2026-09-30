import { beforeEach, expect, test, vi } from "vitest"

const templateFindMany = vi.fn()
const flowFindMany = vi.fn()

vi.mock("@chatbotx.io/database/client", () => ({
  and: vi.fn(),
  db: {
    query: {
      whatsappMessageTemplateModel: { findMany: templateFindMany },
      whatsappFlowModel: { findMany: flowFindMany },
    },
  },
  eq: vi.fn(),
  findOrFail: vi.fn(),
  inArray: vi.fn(),
}))

vi.mock("../src/base.service", () => ({ BaseService: class {} }))

const { WHATSAPP_LIST_INTEGRATION, integrationWhatsappResource } = await import(
  "../src/integration-whatsapp/schema"
)
const { whatsappMessageTemplateService } = await import(
  "../src/whatsapp-message-template/service"
)
const { whatsappFlowService } = await import("../src/whatsapp-flow/service")

beforeEach(() => {
  vi.clearAllMocks()
  templateFindMany.mockResolvedValue([])
  flowFindMany.mockResolvedValue([])
})

// s231a: template and flow lists reach the browser, so the joined WhatsApp
// row is the public resource's allowlist: same keys as the API contract,
// never a credential.
test("the list join selects exactly the public resource's fields", () => {
  const columns = Object.keys(
    WHATSAPP_LIST_INTEGRATION.integrationWhatsapp.columns,
  ).sort()

  expect(columns).toEqual(Object.keys(integrationWhatsappResource.shape).sort())
  expect(columns).not.toContain("auth")
  expect(columns).not.toContain("capiAccessToken")
})

test.each([
  [
    "templates",
    () => whatsappMessageTemplateService.list({ where: { workspaceId: "1" } }),
    templateFindMany,
  ],
  [
    "flows",
    () => whatsappFlowService.list({ where: { workspaceId: "1" } }),
    flowFindMany,
  ],
])("%s list joins through the allowlist", async (_name, call, findMany) => {
  await call()

  const [args] = findMany.mock.calls.at(-1) as [{ with: unknown }]
  expect(args.with).toEqual(WHATSAPP_LIST_INTEGRATION)
})
