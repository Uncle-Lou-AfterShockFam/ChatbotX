import { PgDialect } from "drizzle-orm/pg-core"
import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({ execute: vi.fn() }))

vi.mock("../src/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/client")>()
  return { ...actual, db: { execute: mocks.execute } }
})

const { purgeTrackedLinks } = await import(
  "../src/repositories/tracked-link/repository"
)

const dialect = new PgDialect()
const WS = /\s+/g

function renderQuery(sqlArg: unknown): { text: string; params: unknown[] } {
  const { sql: text, params } = dialect.sqlToQuery(sqlArg as never)
  return { text: text.replace(WS, " ").trim(), params }
}

const OPTIONS = {
  retentionDays: 90,
  chunkSize: 1000,
  interChunkDelayMs: 0,
  maxChunks: 10,
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("purgeTrackedLinks", () => {
  test("deletes every row past the retention window, oldest first", async () => {
    mocks.execute.mockResolvedValue({ rows: [{ id: "l-1" }] })
    const result = await purgeTrackedLinks(OPTIONS)
    expect(result).toEqual({ deleted: 1, stopReason: "drained" })
    const { text, params } = renderQuery(mocks.execute.mock.calls[0]?.[0])
    expect(text).toContain('DELETE FROM "TrackedLink"')
    expect(text).toContain('"createdAt" < NOW() - make_interval(days => $1)')
    expect(text).toContain('ORDER BY "createdAt" ASC')
    expect(text).not.toContain("status")
    expect(params).toEqual([90, 1000])
  })
})
