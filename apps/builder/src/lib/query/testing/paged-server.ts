import { vi } from "vitest"

/** Rows with ids `from`..`to - 1`, as strings (snowflake-like, sortable). */
export const listRows = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => ({
    id: String(from + i),
    name: `row ${from + i}`,
  }))

/**
 * A fake list endpoint that behaves like the real ones: a page is capped at
 * 50 rows (`maxLimit`), whatever `perPage` asks for, and honours an id sort.
 */
export const pagedServer = <T extends { id: string }>(all: T[]) =>
  vi.fn(
    (input: {
      page?: number
      perPage?: number
      sort?: { id: string; desc: boolean }[]
    }) => {
      const ordered = input.sort?.[0]?.desc
        ? [...all].sort((a, b) => Number(b.id) - Number(a.id))
        : all
      const size = Math.min(50, input.perPage ?? 50)
      const start = ((input.page ?? 1) - 1) * size
      return Promise.resolve({ data: ordered.slice(start, start + size) })
    },
  )
