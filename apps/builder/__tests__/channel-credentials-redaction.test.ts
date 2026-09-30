// @vitest-environment node

import { beforeEach, describe, expect, test, vi } from "vitest"

const SECRET = "BOT-TOKEN-SECRET"
const row = (id: string) => ({
  id,
  name: `bot ${id}`,
  inboxId: `inbox-${id}`,
  workspaceId: "ws-1",
  auth: { secretText: SECRET, metadata: { webhookSecretToken: SECRET } },
  capiAccessToken: { iv: SECRET },
})

const listByWorkspace = vi.fn()
const listInboxes = vi.fn()
const findQrCode = vi.fn()
const redirect = vi.fn()

vi.mock("@chatbotx.io/business", () => ({
  telegramIntegrationService: { listByWorkspace },
  inboxService: { list: listInboxes },
  qrCodeService: { find: findQrCode },
  resolveTenantSettings: vi.fn(async () => ({
    appUrl: "https://hub.example",
  })),
}))

vi.mock("@/lib/workspace/load-servable-workspace", () => ({
  loadServableWorkspace: vi.fn(async () => ({ servable: true })),
}))

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => "not-found"),
  redirect,
}))

const { withoutCredentials } = await import("../src/lib/without-credentials")
const { listIntegrationTelegrams } = await import(
  "../src/features/integration-telegram/queries"
)
const { default: LandingPage } = await import(
  "../src/app/l/[workspaceId]/[id]/page"
)

beforeEach(() => {
  vi.clearAllMocks()
})

// s231a: channel `auth` (bot tokens, page tokens, app client secrets) is
// plaintext; a prop crossing into "use client" lands in the RSC payload.
describe("channel credentials never reach a client component", () => {
  test("withoutCredentials drops auth and capiAccessToken, keeps the rest", () => {
    const redacted = withoutCredentials(row("1"))

    expect(redacted).toEqual({
      id: "1",
      name: "bot 1",
      inboxId: "inbox-1",
      workspaceId: "ws-1",
    })
    expect(JSON.stringify(redacted)).not.toContain(SECRET)
  })

  test("withoutCredentials leaves a row without credential columns alone", () => {
    expect(withoutCredentials({ id: "1" })).toEqual({ id: "1" })
  })

  test("the Telegram settings list carries no credential", async () => {
    listByWorkspace.mockResolvedValue([row("1"), row("2")])

    const { data } = await listIntegrationTelegrams({
      where: { workspaceId: "ws-1" },
    })

    expect(data.map((item) => item.id)).toEqual(["1", "2"])
    expect(JSON.stringify(data)).not.toContain(SECRET)
  })

  test("the public QR landing page hands only id, name and channel", async () => {
    findQrCode.mockResolvedValue({ id: "qr-1", name: "Flyer" })
    listInboxes.mockResolvedValue({
      data: [
        {
          id: "11",
          name: "Telegram",
          channel: "telegram",
          sourceId: "bot",
          integrationTelegram: { ...row("1"), botUsername: "hub_bot" },
        },
        {
          id: "12",
          name: "Messenger",
          channel: "messenger",
          sourceId: "page-1",
          integrationMessenger: { ...row("2"), pageId: "page-1" },
        },
      ],
      pageCount: 1,
    })

    const element = (await LandingPage({
      params: Promise.resolve({ workspaceId: "1", id: "2" }),
    })) as { props: { inboxLinks: { inbox: object; url: string }[] } }

    const { inboxLinks } = element.props
    expect(inboxLinks.length).toBeGreaterThan(0)
    for (const { inbox } of inboxLinks) {
      expect(Object.keys(inbox).sort()).toEqual(["channel", "id", "name"])
    }
    expect(JSON.stringify(inboxLinks)).not.toContain(SECRET)
  })
})
