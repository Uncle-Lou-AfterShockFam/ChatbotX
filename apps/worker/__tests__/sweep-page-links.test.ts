import { beforeEach, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  sweepExpired: vi.fn(),
  error: vi.fn(),
}))

vi.mock("@chatbotx.io/business/page", () => ({
  pageService: { sweepExpired: mocks.sweepExpired },
}))
vi.mock("@chatbotx.io/redis", () => ({
  distributedLock: {
    runExclusive: ({ fn }: { fn: () => Promise<unknown> }) => fn(),
  },
}))
vi.mock("../src/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: mocks.error },
}))

const { sweepPageLinks } = await import(
  "../src/schedule/handlers/sweep-page-links"
)

beforeEach(() => {
  vi.clearAllMocks()
})

test("loops while a batch is full, stops on the first short one", async () => {
  mocks.sweepExpired
    .mockResolvedValueOnce(1000)
    .mockResolvedValueOnce(1000)
    .mockResolvedValueOnce(3)
  expect(await sweepPageLinks()).toEqual({ deleted: 2003 })
  expect(mocks.sweepExpired).toHaveBeenCalledTimes(3)
  expect(mocks.sweepExpired).toHaveBeenCalledWith({ batch: 1000 })
})

test("is bounded per run even if every batch is full", async () => {
  mocks.sweepExpired.mockResolvedValue(1000)
  expect(await sweepPageLinks()).toEqual({ deleted: 50_000 })
  expect(mocks.sweepExpired).toHaveBeenCalledTimes(50)
})

test("a failing batch keeps what was deleted and logs, never throws", async () => {
  mocks.sweepExpired
    .mockResolvedValueOnce(1000)
    .mockRejectedValueOnce(new Error("db down"))
  expect(await sweepPageLinks()).toEqual({ deleted: 1000 })
  expect(mocks.error).toHaveBeenCalledOnce()
})
