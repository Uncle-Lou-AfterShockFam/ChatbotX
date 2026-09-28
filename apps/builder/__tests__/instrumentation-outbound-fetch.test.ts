import { afterEach, describe, expect, test, vi } from "vitest"

// s216: the builder's nodejs runtime installs the SSRF-pinned fetch at boot;
// the edge runtime never loads the Node-only subpath.
const install = vi.hoisted(() => vi.fn())

vi.mock("@chatbotx.io/business/net-node", () => ({
  installPinnedOutboundFetch: install,
}))
vi.mock("@chatbotx.io/business/license-startup", () => ({
  assertLicenseAtStartup: vi.fn(async () => undefined),
}))
vi.mock("@/lib/orpc/orpc.server", () => ({}))

const { register } = await import("@/instrumentation")

afterEach(() => {
  vi.unstubAllEnvs()
  install.mockReset()
})

describe("instrumentation register (s216)", () => {
  test("nodejs runtime installs the pinned outbound fetch", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs")
    vi.stubEnv("NEXT_PHASE", "")
    await register()
    expect(install).toHaveBeenCalledTimes(1)
  })

  test("edge runtime does not", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge")
    vi.stubEnv("NEXT_PHASE", "")
    await register()
    expect(install).not.toHaveBeenCalled()
  })
})
