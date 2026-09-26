import { afterEach, describe, expect, test, vi } from "vitest"
import {
  fetchAllListPages,
  LIST_MAX_PAGES,
  ListPageShapeError,
} from "../fetch-all-list-pages"
import { listRows, pagedServer } from "./paged-server"

afterEach(() => {
  vi.restoreAllMocks()
})

describe("fetchAllListPages (s205: the server caps a page at 50)", () => {
  test("120 rows land in 3 calls, ordered by id, 50 per page", async () => {
    const server = pagedServer(listRows(1, 121))

    const rows = await fetchAllListPages(server)

    expect(rows).toHaveLength(120)
    expect(rows.at(-1)?.id).toBe("120")
    expect(server).toHaveBeenCalledTimes(3)
    expect(server).toHaveBeenNthCalledWith(2, {
      page: 2,
      perPage: 50,
      sort: [{ id: "id", desc: false }],
    })
  })

  test("exactly 100 rows stop on the empty third page", async () => {
    const server = pagedServer(listRows(1, 101))

    expect(await fetchAllListPages(server)).toHaveLength(100)
    expect(server).toHaveBeenCalledTimes(3)
  })

  test("an empty list is one call and no rows", async () => {
    const server = pagedServer([])

    expect(await fetchAllListPages(server)).toEqual([])
    expect(server).toHaveBeenCalledTimes(1)
  })

  test("desc asks the server for newest first and keeps that order", async () => {
    const server = pagedServer(listRows(1, 61))

    const rows = await fetchAllListPages(server, { desc: true })

    expect(rows.map((r) => r.id).slice(0, 2)).toEqual(["60", "59"])
    expect(rows.at(-1)?.id).toBe("1")
    expect(server.mock.calls[0][0].sort).toEqual([{ id: "id", desc: true }])
  })

  test("a row that shifts onto the next page is kept once", async () => {
    const all = listRows(1, 61)
    const server = pagedServer(all)

    const rows = await fetchAllListPages(async (input) => {
      const page = await server(input)
      return input.page === 2 ? { data: [all[49], ...page.data] } : page
    })

    expect(rows).toHaveLength(60)
  })

  test("a server that never ends stops at the page cap and warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    let n = 0
    const endless = vi.fn(async () => ({
      data: listRows(n * 50, ++n * 50),
    }))

    const rows = await fetchAllListPages(endless)

    expect(endless).toHaveBeenCalledTimes(LIST_MAX_PAGES)
    expect(rows).toHaveLength(LIST_MAX_PAGES * 50)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain("truncated")
  })

  test("no warning when the last page ends the list", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)

    await fetchAllListPages(pagedServer(listRows(1, 76)))

    expect(warn).not.toHaveBeenCalled()
  })

  test.each([
    ["undefined response", undefined],
    ["null response", null],
    ["missing data", {}],
    ["data not an array", { data: { id: "1" } }],
  ])("a malformed page (%s) throws ListPageShapeError", async (_, response) => {
    const fetchPage = vi.fn(async () => response as never)

    await expect(fetchAllListPages(fetchPage)).rejects.toBeInstanceOf(
      ListPageShapeError,
    )
    expect(fetchPage).toHaveBeenCalledTimes(1)
  })

  test("a rejected page propagates and stops the loop", async () => {
    const server = pagedServer(listRows(1, 121))
    const fetchPage = vi.fn((input: { page: number }) =>
      input.page === 2
        ? Promise.reject(new Error("boom"))
        : server(input as never),
    )

    await expect(fetchAllListPages(fetchPage)).rejects.toThrow("boom")
    expect(fetchPage).toHaveBeenCalledTimes(2)
  })

  test("property: any size 0..500 returns every row exactly once", async () => {
    for (let size = 0; size <= 500; size += 7) {
      const rows = await fetchAllListPages(pagedServer(listRows(1, size + 1)))
      expect(rows.map((r) => r.id)).toEqual(
        listRows(1, size + 1).map((r) => r.id),
      )
    }
  })
})
