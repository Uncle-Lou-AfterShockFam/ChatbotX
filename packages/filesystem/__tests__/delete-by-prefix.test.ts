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
  const deleteObject = vi
    .spyOn(uploader, "deleteObject")
    .mockResolvedValue({} as never)
  return { listObjects, deleteObject }
}

describe("uploader.deleteByPrefix", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  test("deletes every key across pages, skips `except` and keyless entries, reports the count", async () => {
    const { listObjects, deleteObject } = stubPages([
      {
        Contents: [{ Key: "p/a" }, { Key: "p/keep" }, {}],
        IsTruncated: true,
        NextContinuationToken: "t1",
      },
      { Contents: [{ Key: "p/b" }], IsTruncated: false },
    ])
    const result = await uploader.deleteByPrefix("p/", { except: "p/keep" })
    expect(result).toEqual({ deleted: 2 })
    expect(deleteObject.mock.calls.map(([k]) => k)).toEqual(["p/a", "p/b"])
    expect(listObjects).toHaveBeenNthCalledWith(2, "p/", {
      ContinuationToken: "t1",
    })
  })

  test("an empty listing deletes nothing and returns 0", async () => {
    const { deleteObject } = stubPages([{ Contents: [] }])
    expect(await uploader.deleteByPrefix("p/")).toEqual({ deleted: 0 })
    expect(deleteObject).not.toHaveBeenCalled()
  })

  test("refuses an empty or non-string prefix before touching storage (an empty prefix is the whole bucket)", async () => {
    const { listObjects, deleteObject } = stubPages([])
    await expect(uploader.deleteByPrefix("")).rejects.toThrow(TypeError)
    await expect(
      uploader.deleteByPrefix(undefined as unknown as string),
    ).rejects.toThrow(TypeError)
    await expect(
      uploader.deleteByPrefix(null as unknown as string),
    ).rejects.toThrow(TypeError)
    expect(listObjects).not.toHaveBeenCalled()
    expect(deleteObject).not.toHaveBeenCalled()
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

  test("one failed delete in a page: the others still count, and the error says how many are gone", async () => {
    stubPages([{ Contents: [{ Key: "p/a" }, { Key: "p/b" }, { Key: "p/c" }] }])
    const boom = new Error("AccessDenied")
    vi.spyOn(uploader, "deleteObject").mockImplementation((key: string) =>
      key === "p/b" ? Promise.reject(boom) : Promise.resolve({} as never),
    )
    const err = await uploader.deleteByPrefix("p/").catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PrefixPurgeError)
    expect((err as PrefixPurgeError).deleted).toBe(2)
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
