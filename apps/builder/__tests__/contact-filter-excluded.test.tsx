// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { FormProvider, useForm } from "react-hook-form"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
vi.mock("@chatbotx.io/ui/components/form/radio-group-field", () => ({
  RadioGroupField: () => null,
}))
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

const { ContactFilter } = await import(
  "@/features/contact-filter/components/contact-filter"
)

const CONDITIONS = [
  { field: "email", operator: "contains", value: "@vip.com" },
  { field: "fullName", operator: "isNotEmpty" },
]

type Captured = { conditions?: unknown }

// Renders `ContactFilter` inside a real react-hook-form context and exposes
// the form's `contactFilter` value after the mount effects ran.
function Harness(props: {
  excludeFields: string[]
  onExcludedConditions?: () => void
  captured: Captured
}) {
  const form = useForm({
    defaultValues: {
      contactFilter: {
        operator: "and",
        timezone: "UTC",
        conditions: CONDITIONS,
      },
    },
  })
  props.captured.conditions = form.watch("contactFilter.conditions")
  return (
    <FormProvider {...form}>
      <ContactFilter
        excludeFields={props.excludeFields as never}
        onExcludedConditions={props.onExcludedConditions}
        parentName="contactFilter"
      />
    </FormProvider>
  )
}

describe("ContactFilter excluded fields (s206/s208: never widens)", () => {
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

  test("reports an excluded condition and keeps it when the caller opts in", () => {
    const onExcludedConditions = vi.fn()
    const captured: Captured = {}

    act(() => {
      root.render(
        <Harness
          captured={captured}
          excludeFields={["email"]}
          onExcludedConditions={onExcludedConditions}
        />,
      )
    })

    expect(onExcludedConditions).toHaveBeenCalled()
    expect(captured.conditions).toEqual(CONDITIONS)
  })

  test("without the callback it prunes the excluded condition (legacy callers)", () => {
    const captured: Captured = {}

    act(() => {
      root.render(<Harness captured={captured} excludeFields={["email"]} />)
    })

    expect(captured.conditions).toEqual([
      expect.objectContaining({ field: "fullName" }),
    ])
  })

  test("an empty exclude list (the flow condition editor) keeps every saved condition", () => {
    const captured: Captured = {}

    act(() => {
      root.render(<Harness captured={captured} excludeFields={[]} />)
    })

    expect(captured.conditions).toEqual(CONDITIONS)
  })
})

describe("flow condition editor exclude list (s208)", () => {
  test("stays empty: the editor has no onExcludedConditions to surface a prune", async () => {
    vi.doMock("@chatbotx.io/flow-config", () => ({
      conditionCaseDefaultFn: vi.fn(),
    }))
    vi.doMock("@/features/sequences/provider/sequence-store-context", () => ({
      SequenceStoreProvider: () => null,
    }))
    vi.doMock("@/hooks/routing", () => ({ useWorkspaceId: () => "ws-1" }))

    const { CONDITION_EXCLUDED_FILTER_FIELDS } = await import(
      "@/features/flows/react-flow/steps/condition/editor"
    )

    expect(CONDITION_EXCLUDED_FILTER_FIELDS).toEqual([])
  })
})
