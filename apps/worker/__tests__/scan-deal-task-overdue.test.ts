import { beforeEach, describe, expect, test, vi } from "vitest"

const m = vi.hoisted(() => ({
  claimOverdue: vi.fn(),
  runExclusive: vi.fn(),
  logInfo: vi.fn(),
}))
vi.mock("@chatbotx.io/business/deal-task", () => ({
  dealTaskService: { claimOverdue: m.claimOverdue },
}))
vi.mock("@chatbotx.io/redis", () => ({
  distributedLock: { runExclusive: m.runExclusive },
}))
vi.mock("../src/lib/logger", () => ({
  logger: { info: m.logInfo, warn: vi.fn(), error: vi.fn() },
}))

const { scanDealTaskOverdue } = await import(
  "../src/schedule/handlers/scan-deal-task-overdue"
)

beforeEach(() => {
  vi.clearAllMocks()
  m.runExclusive.mockImplementation(({ fn }: { fn: () => Promise<unknown> }) =>
    fn(),
  )
})

describe("scanDealTaskOverdue", () => {
  test("runs the claim under the distributed lock and logs only when something was scanned", async () => {
    m.claimOverdue.mockResolvedValue({ scanned: 2, emitted: 2 })
    expect(await scanDealTaskOverdue()).toEqual({ scanned: 2, emitted: 2 })
    expect(m.runExclusive).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "schedule:scan-deal-task-overdue",
        timeoutInSeconds: 55,
      }),
    )
    expect(m.logInfo).toHaveBeenCalledTimes(1)
    m.claimOverdue.mockResolvedValue({ scanned: 0, emitted: 0 })
    await scanDealTaskOverdue()
    expect(m.logInfo).toHaveBeenCalledTimes(1)
  })

  test("the scheduler registers it every 5 minutes and the worker dispatches it", async () => {
    const { readFileSync } = await import("node:fs")
    expect(
      readFileSync("src/schedule/handlers/register-schedules.ts", "utf8"),
    ).toContain(
      'ScheduleJobData.scanDealTaskOverdue,\n    {\n      pattern: "*/5 * * * *"',
    )
    expect(readFileSync("src/schedule/worker.ts", "utf8")).toContain(
      "case ScheduleJobData.scanDealTaskOverdue:",
    )
  })
})
