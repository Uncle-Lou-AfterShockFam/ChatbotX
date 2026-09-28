// @vitest-environment node

import { beforeEach, describe, expect, test, vi } from "vitest"

const { mockUploadFileFromUrl } = vi.hoisted(() => ({
  mockUploadFileFromUrl: vi.fn(),
}))

vi.mock("@/lib/log", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }))
vi.mock("@chatbotx.io/business/outbound-fetch", () => ({
  outboundDownload: vi.fn(),
}))
vi.mock("@chatbotx.io/filesystem", () => ({
  uploadFileFromUrl: mockUploadFileFromUrl,
}))

const AVATAR_KEY = /^public\/space\/ws-1\/avatars\/[^/]+\.jpg$/

const { buildIntegrationUserInfo } = await import(
  "../src/lib/integration-user-info"
)

describe("buildIntegrationUserInfo avatar key (s218)", () => {
  beforeEach(() => {
    mockUploadFileFromUrl.mockReset()
    mockUploadFileFromUrl.mockImplementation((_url: string, key: string) =>
      Promise.resolve({ originPath: key }),
    )
  })

  test("uploads under the workspace avatars prefix the contact delete purges", async () => {
    const info = await buildIntegrationUserInfo({
      workspaceId: "ws-1",
      userId: "u1",
      userAccessToken: "t",
      avatarUrl: "https://graph.example/pic.jpg",
    })
    const key = mockUploadFileFromUrl.mock.calls[0]?.[1]
    expect(key).toMatch(AVATAR_KEY)
    expect(info?.avatar).toBe(key)
  })
})
