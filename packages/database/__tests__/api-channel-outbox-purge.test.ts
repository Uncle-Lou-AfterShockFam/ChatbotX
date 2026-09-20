import { PgDialect } from "drizzle-orm/pg-core"
import { beforeEach, describe, expect, test, vi } from "vitest"

// Retention on the pull-mode outbox is per STATUS: only settled rows
// (`acked`, `refused`) age out. A `pending` or `leased` row is a text the hub
// still owes a worker; deleting it would drop a send silently.
const mocks = vi.hoisted(() => ({ execute: vi.fn() }))

vi.mock("../src/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/client")>()
  return { ...actual, db: { execute: mocks.execute } }
})

const { purgeSettledApiChannelOutbox } = await import(
  "../src/repositories/api-channel-outbox/repository"
)

const dialect = new PgDialect()
const WS = /\s+/g

function renderQuery(sqlArg: unknown): { text: string; params: unknown[] } {
  const { sql: text, params } = dialect.sqlToQuery(sqlArg as never)
  return { text: text.replace(WS, " ").trim(), params }
}

const OPTIONS = {
  retentionDays: 30,
  chunkSize: 1000,
  interChunkDelayMs: 0,
  maxChunks: 10,
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("purgeSettledApiChannelOutbox", () => {
  test("deletes only acked/refused rows by their settle time", async () => {
    mocks.execute.mockResolvedValue({ rows: [{ id: "o-1" }] })
    const result = await purgeSettledApiChannelOutbox(OPTIONS)
    expect(result).toEqual({ deleted: 1, stopReason: "drained" })
    const { text, params } = renderQuery(mocks.execute.mock.calls[0]?.[0])
    expect(text).toContain('DELETE FROM "ApiChannelOutbox"')
    expect(text).toContain(`"status" IN ('acked', 'refused')`)
    expect(text).toContain('"ackedAt" < NOW() - make_interval(days => $1)')
    expect(text).toContain('ORDER BY "ackedAt" ASC')
    expect(text).not.toContain("'pending'")
    expect(text).not.toContain("'leased'")
    expect(params).toEqual([30, 1000])
  })
})
