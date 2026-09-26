// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
vi.mock(
  "@/features/contact-filter/components/use-contact-filter-configs",
  () => ({
    useContactFilterConfigs: () => ({
      configs: [],
      conditionOptions: [],
      operatorLabelByValue: {},
    }),
  }),
)
vi.mock(
  "@/features/contact-filter/components/contact-filter-condition-row",
  () => ({ ContactFilterConditionRow: () => null }),
)
vi.mock(
  "@/features/contact-filter/components/contact-filter-condition-form",
  () => ({ ContactFilterConditionForm: () => null }),
)
vi.mock(
  "@/features/contact-filter/components/contact-filter-condition-dialog",
  () => ({ ContactFilterConditionEditDialog: () => null }),
)

const { ContactListFilterPanel } = await import(
  "@/features/contact-filter/components/contact-list-filter"
)

const FILTER = {
  operator: "and" as const,
  timezone: "UTC",
  conditions: [
    { field: "email", operator: "contains", value: "@vip.com" },
    { field: "fullName", operator: "isNotEmpty" },
  ],
} as never

describe("ContactListFilterPanel excluded fields (s206: never widens)", () => {
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

  test("reports an excluded condition instead of deleting it when the caller opts in", () => {
    const onFilterChange = vi.fn()
    const onExcludedConditions = vi.fn()

    act(() => {
      root.render(
        <ContactListFilterPanel
          excludeFields={["email"]}
          filter={FILTER}
          onExcludedConditions={onExcludedConditions}
          onFilterChange={onFilterChange}
        />,
      )
    })

    expect(onExcludedConditions).toHaveBeenCalled()
    // Deleting the email condition would list MORE contacts than the filter.
    expect(onFilterChange).not.toHaveBeenCalled()
  })

  test("without the callback it keeps pruning (legacy callers)", () => {
    const onFilterChange = vi.fn()

    act(() => {
      root.render(
        <ContactListFilterPanel
          excludeFields={["email"]}
          filter={FILTER}
          onFilterChange={onFilterChange}
        />,
      )
    })

    expect(onFilterChange).toHaveBeenCalledWith(
      expect.objectContaining({
        conditions: [{ field: "fullName", operator: "isNotEmpty" }],
      }),
    )
  })
})
