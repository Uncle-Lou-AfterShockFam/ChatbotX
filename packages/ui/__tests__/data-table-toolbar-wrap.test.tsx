import { getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { DataTableToolbar } from "../src/components/data-table/data-table-toolbar"

/**
 * s202c: the action row is right-aligned inside the DataTable's
 * `overflow-auto` column. Without wrapping, three buttons on a 390 px phone
 * (e.g. /flows: History, Import, Create) overflowed to the LEFT, where a
 * scroll container cannot reach, so the first button was clipped and
 * unclickable. The row must wrap instead of overflowing.
 */
const WHITESPACE = /\s+/

function Toolbar() {
  const table = useReactTable({
    data: [],
    columns: [{ accessorKey: "name" }],
    getCoreRowModel: getCoreRowModel(),
  })
  return (
    <DataTableToolbar table={table}>
      <button type="button">History</button>
      <button type="button">Import</button>
      <button type="button">Create</button>
    </DataTableToolbar>
  )
}

describe("DataTableToolbar action row", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
  })

  test("wraps its buttons rather than overflowing past the left edge", () => {
    act(() => {
      root.render(<Toolbar />)
    })
    const row = container.querySelector<HTMLElement>(
      '[data-slot="data-table-toolbar-actions"]',
    )
    expect(row?.textContent).toBe("HistoryImportCreate")
    expect(row?.className.split(WHITESPACE)).toContain("flex-wrap")
  })
})
