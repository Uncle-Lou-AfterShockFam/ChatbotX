import { describe, expect, test, vi } from "vitest"

// s216: every worker entry imports lib/bootstrap, which must install the
// SSRF-pinned fetch at load (before any job) or outboundFetch fails closed.
const install = vi.hoisted(() => vi.fn())

vi.mock("@chatbotx.io/business/net-node", () => ({
  installPinnedOutboundFetch: install,
}))
vi.mock("@chatbotx.io/business/license-startup", () => ({
  assertLicenseAtStartup: vi.fn(async () => undefined),
}))

describe("worker bootstrap (s216)", () => {
  test("installs the pinned outbound fetch when the module loads", async () => {
    await import("../src/lib/bootstrap")
    expect(install).toHaveBeenCalledTimes(1)
  })
})
