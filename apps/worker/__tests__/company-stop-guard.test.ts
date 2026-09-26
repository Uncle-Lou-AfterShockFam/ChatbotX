import { describe, expect, test, vi } from "vitest"

vi.mock("../src/lib/logger", () => ({
  logger: { warn: vi.fn() },
}))
vi.mock("../src/integration/handlers/smart-delay", () => ({
  wasCompanyStoppedSince: vi.fn(),
}))

const {
  assertCompanyNotStoppedSince,
  CompanyStoppedError,
  resolveRunStartedAt,
} = await import("../src/integration/handlers/company-stop-guard")
const { wasCompanyStoppedSince } = await import(
  "../src/integration/handlers/smart-delay"
)
const { logger } = await import("../src/lib/logger")

const JOB_AT = Date.parse("2026-09-26T03:00:00.000Z")

describe("resolveRunStartedAt", () => {
  test("a job that opens a run starts at its own enqueue time", () => {
    expect(resolveRunStartedAt(undefined, JOB_AT)).toEqual(new Date(JOB_AT))
    expect(resolveRunStartedAt("", JOB_AT)).toEqual(new Date(JOB_AT))
  })

  test("a continuation keeps the start of the run that queued it", () => {
    const carried = "2026-09-26T02:00:00.000Z"
    expect(resolveRunStartedAt(carried, JOB_AT)).toEqual(new Date(carried))
  })

  test("a carried start later than the job never makes the run look younger", () => {
    expect(resolveRunStartedAt("2026-09-26T04:00:00.000Z", JOB_AT)).toEqual(
      new Date(JOB_AT),
    )
  })

  test("a malformed carried start falls back to the job's enqueue time", () => {
    for (const bad of ["not-a-date", "2026-13-45", "{}"]) {
      expect(resolveRunStartedAt(bad, JOB_AT), bad).toEqual(new Date(JOB_AT))
    }
  })
})

describe("assertCompanyNotStoppedSince", () => {
  const props = {
    workspaceId: "ws-1",
    contactInboxId: "ci-1",
    runStartedAt: new Date(JOB_AT),
  }

  test("a company stopped after the run start throws CompanyStoppedError", async () => {
    vi.mocked(wasCompanyStoppedSince).mockResolvedValueOnce(true)

    const err = await assertCompanyNotStoppedSince(props).catch((e) => e)

    expect(err).toBeInstanceOf(CompanyStoppedError)
    expect(err).toMatchObject({
      contactInboxId: "ci-1",
      runStartedAt: new Date(JOB_AT),
    })
    expect(wasCompanyStoppedSince).toHaveBeenCalledWith(
      { workspaceId: "ws-1", contactInboxId: "ci-1" },
      new Date(JOB_AT),
    )
  })

  test("a live company (or none) passes", async () => {
    vi.mocked(wasCompanyStoppedSince).mockResolvedValueOnce(false)
    await expect(assertCompanyNotStoppedSince(props)).resolves.toBeUndefined()
  })

  test("no run start skips the lookup", async () => {
    vi.mocked(wasCompanyStoppedSince).mockClear()
    await expect(
      assertCompanyNotStoppedSince({ ...props, runStartedAt: undefined }),
    ).resolves.toBeUndefined()
    expect(wasCompanyStoppedSince).not.toHaveBeenCalled()
  })

  test("a failed lookup is logged and passes", async () => {
    vi.mocked(wasCompanyStoppedSince).mockRejectedValueOnce(
      new Error("pg down"),
    )
    await expect(assertCompanyNotStoppedSince(props)).resolves.toBeUndefined()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ contactInboxId: "ci-1" }),
      expect.stringContaining("check failed"),
    )
  })
})
