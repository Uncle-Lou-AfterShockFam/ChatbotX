import { beforeEach, describe, expect, it, vi } from "vitest"

const execute = vi.fn()
vi.mock("@chatbotx.io/database/client", () => ({
  db: { execute: (...args: unknown[]) => execute(...args) },
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
    { raw: (v: string) => v },
  ),
}))

const info = vi.fn()
const warn = vi.fn()
vi.mock("@chatbotx.io/logger", () => ({
  getChildLogger: () => ({ info, warn, error: vi.fn() }),
}))

const load = async () =>
  (await import("../src/schedule/handlers/purge-tracked-links"))
    .purgeTrackedLinks

const rows = (n: number) => ({
  rows: Array.from({ length: n }, (_, i) => ({ id: String(i) })),
})

describe("purgeTrackedLinks", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    execute.mockReset()
    info.mockReset()
    warn.mockReset()
  })

  it("stops after the first short chunk and logs the count", async () => {
    const purge = await load()
    execute.mockResolvedValueOnce(rows(10))
    await purge()
    expect(execute).toHaveBeenCalledTimes(1)
    expect(info).toHaveBeenCalledWith(
      { deleted: 10 },
      expect.stringContaining("rows purged"),
    )
    expect(warn).not.toHaveBeenCalled()
  })

  it("keeps deleting while chunks come back full", async () => {
    const purge = await load()
    execute
      .mockResolvedValueOnce(rows(1000))
      .mockResolvedValueOnce(rows(1000))
      .mockResolvedValueOnce(rows(3))
    await purge()
    expect(execute).toHaveBeenCalledTimes(3)
  })

  it("is silent when nothing is due", async () => {
    const purge = await load()
    execute.mockResolvedValueOnce(rows(0))
    await purge()
    expect(info).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })
})
