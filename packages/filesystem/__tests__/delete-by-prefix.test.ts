import { DeleteObjectsCommand, S3Client } from "@aws-sdk/client-s3"
import { afterEach, describe, expect, test, vi } from "vitest"

process.env.S3_REGION ??= "test"
process.env.S3_BUCKET ??= "test-bucket"

const {
  DEFAULT_DELETE_BY_PREFIX_MAX_PAGES,
  PrefixPurgeError,
  PrefixTooLargeError,
  uploader,
} = await import("../src/lib/uploader")

type Page = {
  Contents?: { Key?: string }[]
  IsTruncated?: boolean
  NextContinuationToken?: string
}

function stubPages(pages: Page[]) {
  let i = 0
  const listObjects = vi
    .spyOn(uploader, "listObjects")
    .mockImplementation(() =>
      Promise.resolve((pages[i++] ?? { Contents: [] }) as never),
    )
  const deleteObjects = vi
    .spyOn(uploader, "deleteObjects")
    .mockImplementation((keys: string[]) =>
      Promise.resolve({ deleted: keys.length }),
    )
  return { listObjects, deleteObjects }
}

describe("uploader.deleteByPrefix", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  test("deletes every key across pages, skips `except` and keyless entries, reports the count", async () => {
    const { listObjects, deleteObjects } = stubPages([
      {
        Contents: [{ Key: "p/a" }, { Key: "p/keep" }, {}],
        IsTruncated: true,
        NextContinuationToken: "t1",
      },
      { Contents: [{ Key: "p/b" }], IsTruncated: false },
    ])
    const result = await uploader.deleteByPrefix("p/", { except: "p/keep" })
    expect(result).toEqual({ deleted: 2 })
    // One multi-object request per listing page, never one call per key.
    expect(deleteObjects.mock.calls.map(([k]) => k)).toEqual([["p/a"], ["p/b"]])
    expect(listObjects).toHaveBeenNthCalledWith(2, "p/", {
      ContinuationToken: "t1",
    })
  })

  test("an empty listing deletes nothing and returns 0", async () => {
    const { deleteObjects } = stubPages([{ Contents: [] }])
    expect(await uploader.deleteByPrefix("p/")).toEqual({ deleted: 0 })
    expect(deleteObjects).toHaveBeenCalledWith([])
  })

  test("refuses an empty or non-string prefix before touching storage (an empty prefix is the whole bucket)", async () => {
    const { listObjects, deleteObjects } = stubPages([])
    await expect(uploader.deleteByPrefix("")).rejects.toThrow(TypeError)
    await expect(
      uploader.deleteByPrefix(undefined as unknown as string),
    ).rejects.toThrow(TypeError)
    await expect(
      uploader.deleteByPrefix(null as unknown as string),
    ).rejects.toThrow(TypeError)
    expect(listObjects).not.toHaveBeenCalled()
    expect(deleteObjects).not.toHaveBeenCalled()
  })

  test("a listing that never ends is cut off at maxPages with a typed error that carries the partial count", async () => {
    const endless: Page = {
      Contents: [{ Key: "p/x" }],
      IsTruncated: true,
      NextContinuationToken: "again",
    }
    const { listObjects } = stubPages(Array.from({ length: 10 }, () => endless))
    const err = await uploader
      .deleteByPrefix("p/", { maxPages: 3 })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PrefixTooLargeError)
    expect(err).toBeInstanceOf(PrefixPurgeError)
    expect((err as PrefixTooLargeError).deleted).toBe(3)
    expect((err as PrefixTooLargeError).maxPages).toBe(3)
    expect(listObjects).toHaveBeenCalledTimes(3)
  })

  test("one failed key in a page: the others still count, and the error says how many are gone", async () => {
    stubPages([{ Contents: [{ Key: "p/a" }, { Key: "p/b" }, { Key: "p/c" }] }])
    const boom = new Error("AccessDenied")
    vi.spyOn(uploader, "deleteObjects").mockResolvedValue({
      deleted: 2,
      firstFailure: boom,
    })
    const err = await uploader.deleteByPrefix("p/").catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PrefixPurgeError)
    expect((err as PrefixPurgeError).deleted).toBe(2)
    expect((err as PrefixPurgeError).cause).toBe(boom)
  })

  test("a rejected multi-delete request stops the purge with the count from earlier pages only", async () => {
    stubPages([
      {
        Contents: [{ Key: "p/a" }],
        IsTruncated: true,
        NextContinuationToken: "t",
      },
      { Contents: [{ Key: "p/b" }] },
    ])
    const boom = new Error("socket hang up")
    vi.spyOn(uploader, "deleteObjects")
      .mockResolvedValueOnce({ deleted: 1 })
      .mockRejectedValueOnce(boom)
    const err = await uploader.deleteByPrefix("p/").catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PrefixPurgeError)
    expect((err as PrefixPurgeError).deleted).toBe(1)
    expect((err as PrefixPurgeError).cause).toBe(boom)
  })

  test("the default cap is finite and the errors name prefix, cap and count", () => {
    expect(DEFAULT_DELETE_BY_PREFIX_MAX_PAGES).toBeGreaterThan(0)
    const err = new PrefixTooLargeError("p/", 7, 42)
    expect(err.name).toBe("PrefixTooLargeError")
    expect(err.message).toContain("p/")
    expect(err.message).toContain("7")
    expect(err.message).toContain("42")
  })

  test("a listing error before anything was deleted propagates with deleted = 0 (the best-effort wrapper lives in business, not here)", async () => {
    vi.spyOn(uploader, "listObjects").mockRejectedValue(new Error("boom"))
    const err = await uploader.deleteByPrefix("p/").catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PrefixPurgeError)
    expect((err as PrefixPurgeError).deleted).toBe(0)
    expect(((err as PrefixPurgeError).cause as Error).message).toBe("boom")
  })
})

describe("uploader.deleteObjects (the multi-object reply is counted per key)", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function stubReply(reply: unknown) {
    return vi
      .spyOn(S3Client.prototype, "send")
      .mockImplementation(() => Promise.resolve(reply as never))
  }

  test("an empty key list sends nothing", async () => {
    const send = stubReply({})
    expect(await uploader.deleteObjects([])).toEqual({ deleted: 0 })
    expect(send).not.toHaveBeenCalled()
  })

  test("sends ONE DeleteObjectsCommand with every key and counts the confirmed ones", async () => {
    const send = stubReply({ Deleted: [{ Key: "p/a" }, { Key: "p/b" }] })
    expect(await uploader.deleteObjects(["p/a", "p/b"])).toEqual({ deleted: 2 })
    expect(send).toHaveBeenCalledTimes(1)
    const command = send.mock.calls[0]?.[0] as DeleteObjectsCommand
    expect(command).toBeInstanceOf(DeleteObjectsCommand)
    expect(command.input.Delete?.Objects).toEqual([
      { Key: "p/a" },
      { Key: "p/b" },
    ])
  })

  test("a per-key error in the reply is the first failure; the rest still count", async () => {
    stubReply({
      Deleted: [{ Key: "p/a" }],
      Errors: [{ Key: "p/b", Code: "AccessDenied", Message: "no" }],
    })
    const result = await uploader.deleteObjects(["p/a", "p/b"])
    expect(result.deleted).toBe(1)
    expect(String(result.firstFailure)).toContain("AccessDenied")
    expect(String(result.firstFailure)).toContain("p/b")
  })

  test("a key the reply never mentions is a failure, and keys we did not ask for are not counted", async () => {
    stubReply({ Deleted: [{ Key: "p/a" }, { Key: "other/x" }] })
    const result = await uploader.deleteObjects(["p/a", "p/b"])
    expect(result.deleted).toBe(1)
    expect(String(result.firstFailure)).toContain("1 of 2")
  })

  test("an empty reply (no Deleted, no Errors) confirms nothing", async () => {
    stubReply({})
    const result = await uploader.deleteObjects(["p/a"])
    expect(result.deleted).toBe(0)
    expect(result.firstFailure).toBeInstanceOf(Error)
  })
})
