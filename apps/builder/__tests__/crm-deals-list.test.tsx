// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

/** DealsList (s195): rows show pipeline · stage by NAME (never ids), status + overdue badges, click hands the deal up. */
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useFormatter: () => ({
    number: (n: number, o: { currency: string }) => `${o.currency} ${n}`,
  }),
}))

const { DealsList } = await import("@/features/crm/components/deals-list")

const pipelines = [
  {
    id: "p-1",
    name: "Sales",
    stages: [{ id: "s-1", name: "New" }],
  },
] as never

describe("DealsList", () => {
  let container: HTMLDivElement
  let root: Root
  beforeEach(() => {
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  test("empty state", () => {
    act(() =>
      root.render(
        <DealsList deals={[]} onOpen={vi.fn()} pipelines={pipelines} />,
      ),
    )
    expect(container.textContent).toContain("crm.noDeals")
  })

  test("names, money, badges, click", () => {
    const onOpen = vi.fn()
    const deals = [
      {
        id: "d-1",
        title: "Roof",
        pipelineId: "p-1",
        stageId: "s-1",
        status: "open",
        value: "10.50",
        currency: "USD",
        dueAt: new Date(Date.now() - 86_400_000),
      },
      {
        id: "d-2",
        title: "Gutter",
        pipelineId: "p-x",
        stageId: "s-x",
        status: "won",
        value: null,
        currency: "USD",
        dueAt: null,
      },
    ] as never
    act(() =>
      root.render(
        <DealsList deals={deals} onOpen={onOpen} pipelines={pipelines} />,
      ),
    )
    const rows = container.querySelectorAll('[data-testid="crm-deal-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.textContent).toContain("Sales · New")
    expect(rows[0]?.textContent).toContain("USD 10.5")
    expect(rows[0]?.textContent).toContain("deals.overdue")
    expect(rows[0]?.textContent).toContain("deals.statuses.open")
    // an unknown pipeline / stage id never leaks as a raw id
    expect(rows[1]?.textContent).not.toContain("p-x")
    expect(rows[1]?.textContent).not.toContain("s-x")
    expect(rows[1]?.textContent).not.toContain("deals.overdue")
    act(() => (rows[0] as HTMLButtonElement).click())
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "d-1" }))
  })
})
