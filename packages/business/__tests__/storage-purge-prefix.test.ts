import { beforeEach, describe, expect, test, vi } from "vitest"

const deleteByPrefix = vi.fn()
class PrefixPurgeError extends Error {
  readonly prefix: string
  readonly deleted: number

  constructor(prefix: string, deleted: number) {
    super("partial")
    this.prefix = prefix
    this.deleted = deleted
  }
}
vi.mock("@chatbotx.io/filesystem", () => ({
  PrefixPurgeError,
  uploader: { deleteByPrefix },
}))
const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() }
vi.mock("../src/logger", () => ({ logger }))

const { purgeStoragePrefix } = await import("../src/storage/purge-prefix")

describe("purgeStoragePrefix", () => {
  beforeEach(() => {
    deleteByPrefix.mockReset()
    logger.warn.mockClear()
    logger.error.mockClear()
  })

  test("delegates to the uploader with the options and returns the count", async () => {
    deleteByPrefix.mockResolvedValue({ deleted: 3 })
    const n = await purgeStoragePrefix("w/1/", { workspaceId: "1" }, "t", {
      except: "w/1/keep",
    })
    expect(n).toBe(3)
    expect(deleteByPrefix).toHaveBeenCalledWith("w/1/", { except: "w/1/keep" })
    expect(logger.warn).not.toHaveBeenCalled()
  })

  test("a storage failure is swallowed, logged with the prefix and context, and reported as 0", async () => {
    const err = new Error("S3 down")
    deleteByPrefix.mockRejectedValue(err)
    await expect(
      purgeStoragePrefix("w/1/", { workspaceId: "1" }, "contact-delete"),
    ).resolves.toBe(0)
    expect(logger.warn).toHaveBeenCalledWith(
      { workspaceId: "1", prefix: "w/1/", err },
      "contact-delete: failed to purge storage objects under prefix",
    )
  })

  test("a PARTIAL purge (some objects gone) is logged at error level with the count and reported as that count", async () => {
    const err = new PrefixPurgeError("w/1/", 1500)
    deleteByPrefix.mockRejectedValue(err)
    await expect(
      purgeStoragePrefix("w/1/", { workspaceId: "1" }, "workspace-purge"),
    ).resolves.toBe(1500)
    expect(logger.error).toHaveBeenCalledWith(
      { workspaceId: "1", prefix: "w/1/", deleted: 1500, err },
      "workspace-purge: storage purge stopped early, objects remain under prefix",
    )
    expect(logger.warn).not.toHaveBeenCalled()
  })

  test("a purge error with nothing deleted yet is the transient case: warn, 0", async () => {
    const err = new PrefixPurgeError("w/1/", 0)
    deleteByPrefix.mockRejectedValue(err)
    await expect(purgeStoragePrefix("w/1/", {}, "t")).resolves.toBe(0)
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.error).not.toHaveBeenCalled()
  })

  test("a bad prefix is a caller bug and is rethrown, never swallowed", async () => {
    for (const bad of ["", undefined, null, 42]) {
      await expect(
        purgeStoragePrefix(bad as unknown as string, {}, "t"),
      ).rejects.toThrow(TypeError)
    }
    expect(deleteByPrefix).not.toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
  })
})
