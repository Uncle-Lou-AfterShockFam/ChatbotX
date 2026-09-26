import { fetchAllPages } from "./fetch-all-pages"

/**
 * The list endpoints cap a page at 50 (`maxLimit` in
 * `@chatbotx.io/database/utils`), so a single `perPage: maxPerPage` call
 * silently returned the first 50 rows only: a workspace with more never saw
 * the rest in any picker (s201 fields, s205 every other store). Page through
 * all of them, ordered by id so offset pages are stable.
 */
export const LIST_PAGE_SIZE = 50
export const LIST_MAX_PAGES = 40

export type ListPageRequest = {
  page: number
  perPage: number
  sort: { id: string; desc: boolean }[]
}

export class ListPageShapeError extends Error {
  constructor(page: number) {
    super(`list page ${page} returned no data array`)
    this.name = "ListPageShapeError"
  }
}

/**
 * `desc` keeps a newest-first list newest-first: ids are snowflakes, so id
 * order is creation order.
 */
export const fetchAllListPages = async <T extends { id: unknown }>(
  fetchPage: (input: ListPageRequest) => Promise<{ data: T[] }>,
  options?: { desc?: boolean },
): Promise<T[]> => {
  const desc = options?.desc ?? false
  let lastFull = false
  const rows = await fetchAllPages<number, T>({
    initialPageParam: 1,
    maxPages: LIST_MAX_PAGES,
    fetchPage: async (page) => {
      const response = await fetchPage({
        page,
        perPage: LIST_PAGE_SIZE,
        sort: [{ id: "id", desc }],
      })
      if (!Array.isArray(response?.data)) {
        throw new ListPageShapeError(page)
      }
      const { data } = response
      lastFull = data.length >= LIST_PAGE_SIZE
      return {
        items: data,
        nextPageParam: lastFull ? page + 1 : undefined,
      }
    },
  })
  if (lastFull) {
    console.warn(
      `fetchAllListPages: stopped at ${LIST_MAX_PAGES} pages (${LIST_MAX_PAGES * LIST_PAGE_SIZE} rows); the list is truncated`,
    )
  }
  return [...new Map(rows.map((row) => [row.id, row])).values()]
}
