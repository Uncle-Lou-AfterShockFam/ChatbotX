import { DeleteObjectsCommand, S3Client } from "@aws-sdk/client-s3"
import { afterEach, describe, expect, test, vi } from "vitest"

process.env.S3_REGION ??= "test"
process.env.S3_BUCKET ??= "test-bucket"

const {
  DEFAULT_DELETE_BY_PREFIX_MAX_PAGES,
  MAX_DELETE_OBJECTS_KEYS,
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

  test("a whole multi-delete REQUEST refused: the page falls back to per-key deletes and one bad key fails alone", async () => {
    stubPages([
      {
        Contents: [{ Key: "p/a" }],
        IsTruncated: true,
        NextContinuationToken: "t",
      },
      { Contents: [{ Key: "p/b" }, { Key: "p/bad" }, { Key: "p/c" }] },
    ])
    const refused = new Error("MalformedXML")
    vi.spyOn(uploader, "deleteObjects")
      .mockResolvedValueOnce({ deleted: 1 })
      .mockRejectedValueOnce(refused)
    const badKey = new Error("InvalidArgument")
    const deleteObject = vi
      .spyOn(uploader, "deleteObject")
      .mockImplementation((key: string) =>
        key === "p/bad" ? Promise.reject(badKey) : Promise.resolve({} as never),
      )
    const err = await uploader.deleteByPrefix("p/").catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PrefixPurgeError)
    // 1 from page 1, 2 of 3 from the per-key pass on page 2.
    expect((err as PrefixPurgeError).deleted).toBe(3)
    expect((err as PrefixPurgeError).cause).toBe(badKey)
    expect(deleteObject.mock.calls.map(([k]) => k).sort()).toEqual([
      "p/b",
      "p/bad",
      "p/c",
    ])
  })

  test("a refused request whose per-key pass fully succeeds keeps paging and returns the full count", async () => {
    stubPages([
      {
        Contents: [{ Key: "p/a" }, { Key: "p/b" }],
        IsTruncated: true,
        NextContinuationToken: "t",
      },
      { Contents: [{ Key: "p/c" }] },
    ])
    vi.spyOn(uploader, "deleteObjects")
      .mockRejectedValueOnce(new Error("MalformedXML"))
      .mockResolvedValueOnce({ deleted: 1 })
    vi.spyOn(uploader, "deleteObject").mockResolvedValue({} as never)
    expect(await uploader.deleteByPrefix("p/")).toEqual({ deleted: 3 })
  })

  test("a listing marked truncated with no continuation token is a partial purge, not success", async () => {
    stubPages([{ Contents: [{ Key: "p/a" }], IsTruncated: true }])
    const err = await uploader.deleteByPrefix("p/").catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PrefixPurgeError)
    expect((err as PrefixPurgeError).deleted).toBe(1)
    expect(String((err as PrefixPurgeError).cause)).toContain(
      "no continuation token",
    )
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

  test("a key acknowledged twice counts once and cannot hide a missing key (s201c Codex probe)", async () => {
    stubReply({ Deleted: [{ Key: "p/a" }, { Key: "p/a" }] })
    const result = await uploader.deleteObjects(["p/a", "p/b"])
    expect(result.deleted).toBe(1)
    expect(String(result.firstFailure)).toContain("1 of 2")
  })

  test("a key repeated in the request is sent once and counted once", async () => {
    const send = stubReply({ Deleted: [{ Key: "p/a" }] })
    expect(await uploader.deleteObjects(["p/a", "p/a"])).toEqual({ deleted: 1 })
    const command = send.mock.calls[0]?.[0] as DeleteObjectsCommand
    expect(command.input.Delete?.Objects).toEqual([{ Key: "p/a" }])
  })

  test("a key named in BOTH Deleted and Errors counts as failed, not deleted", async () => {
    stubReply({
      Deleted: [{ Key: "p/a" }, { Key: "p/b" }],
      Errors: [{ Key: "p/b", Code: "AccessDenied" }],
    })
    const result = await uploader.deleteObjects(["p/a", "p/b"])
    expect(result.deleted).toBe(1)
    expect(String(result.firstFailure)).toContain("AccessDenied")
  })

  test("more than 1000 distinct keys is refused before any request (S3's per-request cap)", async () => {
    const send = stubReply({})
    const keys = Array.from(
      { length: MAX_DELETE_OBJECTS_KEYS + 1 },
      (_, i) => `p/${i}`,
    )
    await expect(uploader.deleteObjects(keys)).rejects.toThrow(RangeError)
    expect(send).not.toHaveBeenCalled()
  })

  test("exactly 1000 keys, or 1001 entries that collapse to 1000 distinct, is one request", async () => {
    const keys = Array.from(
      { length: MAX_DELETE_OBJECTS_KEYS },
      (_, i) => `p/${i}`,
    )
    const send = stubReply({ Deleted: keys.map((Key) => ({ Key })) })
    expect(await uploader.deleteObjects([...keys, "p/0"])).toEqual({
      deleted: MAX_DELETE_OBJECTS_KEYS,
    })
    expect(send).toHaveBeenCalledTimes(1)
  })

  test("an empty reply (no Deleted, no Errors) confirms nothing", async () => {
    stubReply({})
    const result = await uploader.deleteObjects(["p/a"])
    expect(result.deleted).toBe(0)
    expect(result.firstFailure).toBeInstanceOf(Error)
  })
})
