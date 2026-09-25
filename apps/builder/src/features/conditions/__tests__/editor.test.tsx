// @vitest-environment jsdom
import {
  type TriggerEventType,
  triggerEventTypes,
} from "@chatbotx.io/database/partials"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { FormProvider, useForm } from "react-hook-form"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { ConditionEditor } from "../editor"

vi.mock("@chatbotx.io/ui/components/form/input-field", () => ({
  InputField: (props: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input {...props} />
  ),
}))

// Both field mocks render a native <select> tagged with the component name so
// tests can assert which field a condition type uses.
const { createFieldMock } = vi.hoisted(() => ({
  createFieldMock: async (component: "select" | "combobox") => {
    const { useFormContext } = await import("react-hook-form")

    return ({
      name,
      options,
    }: {
      name: string
      options: { label: string; value: string }[]
    }) => {
      const form = useFormContext()

      return (
        <select data-component={component} {...form.register(name)} name={name}>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      )
    }
  },
}))

vi.mock("@chatbotx.io/ui/components/form/select-field", async () => ({
  SelectField: await createFieldMock("select"),
}))

vi.mock("@chatbotx.io/ui/components/form/combobox-field", async () => ({
  ComboboxField: await createFieldMock("combobox"),
}))

vi.mock("@/features/sequences/provider/sequence-hook", () => ({
  useSequenceOptions: () => [
    { id: "sequence-1", name: "Welcome" },
    { id: "sequence-2", name: "Retention" },
  ],
}))

vi.mock("@/features/tags/provider/tag-hook", () => ({
  useTagSelectOptions: () => [
    { label: "VIP", value: "tag-1" },
    { label: "Lead", value: "tag-2" },
  ],
}))

vi.mock("@/features/forms/provider/form-hooks", () => ({
  useFormOptions: () => [
    { label: "Demo intake (demo-intake)", value: "form-1" },
  ],
}))
vi.mock("@/features/pipelines/provider/pipeline-hook", () => ({
  usePipelineOptions: () => [
    { label: "Sales", value: "pipe-1" },
    { label: "Support", value: "pipe-2" },
  ],
  useStageOptionsGroupedByPipeline: () => [
    {
      label: "Sales",
      value: "pipeline:pipe-1",
      children: [
        { label: "Sales / New", value: "stage-1" },
        { label: "Sales / Won", value: "stage-2" },
      ],
    },
  ],
}))

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

vi.mock("../custom-field-value-changed", () => ({
  CustomFieldValueChanged: () => null,
}))

vi.mock("../date-time-based-trigger", () => ({
  DateTimeBasedTrigger: () => null,
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

const render = (ui: React.ReactElement) => {
  act(() => {
    root.render(ui)
  })
}

function TestConditionEditor({
  defaultSourceId = "sequence-2",
  type = triggerEventTypes.enum.subscribedToSequence,
  onSubmit,
}: {
  defaultSourceId?: string
  type?: TriggerEventType
  onSubmit?: (values: { conditions: { sourceId: string }[] }) => void
}) {
  const form = useForm({
    defaultValues: {
      conditions: [{ sourceId: defaultSourceId }],
    },
  })

  return (
    <FormProvider {...form}>
      <form onSubmit={form.handleSubmit((values) => onSubmit?.(values))}>
        <ConditionEditor parentName="conditions.0" type={type} />
        <button type="submit">Save</button>
      </form>
    </FormProvider>
  )
}

describe("ConditionEditor", () => {
  test("saves and reloads sequence source id for sequence subscription conditions", async () => {
    const onSubmit = vi.fn()
    render(<TestConditionEditor onSubmit={onSubmit} />)

    const select = container.querySelector(
      'select[name="conditions.0.sourceId"]',
    )
    expect(select).toBeInstanceOf(HTMLSelectElement)
    expect(select?.getAttribute("data-component")).toBe("combobox")
    expect(
      Array.from(select?.querySelectorAll("option") ?? []).map((option) => ({
        label: option.textContent,
        value: option.getAttribute("value"),
      })),
    ).toEqual([
      { label: "Welcome", value: "sequence-1" },
      { label: "Retention", value: "sequence-2" },
    ])
    expect((select as HTMLSelectElement).value).toBe("sequence-2")

    act(() => {
      ;(select as HTMLSelectElement).value = "sequence-1"
      select?.dispatchEvent(new Event("change", { bubbles: true }))
    })
    act(() => {
      container
        .querySelector("form")
        ?.dispatchEvent(
          new SubmitEvent("submit", { bubbles: true, cancelable: true }),
        )
    })

    await vi.waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        conditions: [{ sourceId: "sequence-1" }],
      })
    })

    render(<TestConditionEditor defaultSourceId="sequence-1" />)
    expect(
      (
        container.querySelector(
          'select[name="conditions.0.sourceId"]',
        ) as HTMLSelectElement
      ).value,
    ).toBe("sequence-1")
  })

  test.each([
    triggerEventTypes.enum.tagApplied,
    triggerEventTypes.enum.tagRemoved,
  ])("uses a searchable combobox for %s tag conditions and saves the tag id", async (type) => {
    const onSubmit = vi.fn()
    render(
      <TestConditionEditor
        defaultSourceId="tag-2"
        onSubmit={onSubmit}
        type={type}
      />,
    )

    const select = container.querySelector(
      'select[name="conditions.0.sourceId"]',
    ) as HTMLSelectElement
    expect(select.getAttribute("data-component")).toBe("combobox")
    expect(
      Array.from(select.querySelectorAll("option")).map((option) => ({
        label: option.textContent,
        value: option.getAttribute("value"),
      })),
    ).toEqual([
      { label: "VIP", value: "tag-1" },
      { label: "Lead", value: "tag-2" },
    ])
    expect(select.value).toBe("tag-2")

    act(() => {
      select.value = "tag-1"
      select.dispatchEvent(new Event("change", { bubbles: true }))
    })
    act(() => {
      container
        .querySelector("form")
        ?.dispatchEvent(
          new SubmitEvent("submit", { bubbles: true, cancelable: true }),
        )
    })

    await vi.waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        conditions: [{ sourceId: "tag-1" }],
      })
    })
  })

  test("offers phone and email source options for contact info updated conditions", () => {
    render(
      <TestConditionEditor
        defaultSourceId="phone"
        type={triggerEventTypes.enum.contactInfoUpdated}
      />,
    )

    const select = container.querySelector(
      'select[name="conditions.0.sourceId"]',
    )
    expect(select).toBeInstanceOf(HTMLSelectElement)
    expect(select?.getAttribute("data-component")).toBe("select")
    expect(
      Array.from(select?.querySelectorAll("option") ?? []).map((option) => ({
        label: option.textContent,
        value: option.getAttribute("value"),
      })),
    ).toEqual([
      { label: "fields.phone.label", value: "phone" },
      { label: "fields.email.label", value: "email" },
    ])
    expect((select as HTMLSelectElement).value).toBe("phone")
  })

  test.each([
    triggerEventTypes.enum.ticketCreated,
    triggerEventTypes.enum.ticketValueChanged,
    triggerEventTypes.enum.ticketStatusChanged,
    triggerEventTypes.enum.ticketPriorityChanged,
    triggerEventTypes.enum.dealMentioned,
  ])("%s pins the condition to a pipeline through a combobox", (type) => {
    render(<TestConditionEditor defaultSourceId="pipe-2" type={type} />)
    const select = container.querySelector(
      'select[name="conditions.0.sourceId"]',
    ) as HTMLSelectElement
    expect(select.getAttribute("data-component")).toBe("combobox")
    expect(
      Array.from(select.querySelectorAll("option")).map((option) =>
        option.getAttribute("value"),
      ),
    ).toEqual(["pipe-1", "pipe-2"])
    expect(select.value).toBe("pipe-2")
  })

  test("ticketMovedToStage pins the condition to a destination stage, never a pipeline", () => {
    render(
      <TestConditionEditor
        defaultSourceId="stage-2"
        type={triggerEventTypes.enum.ticketMovedToStage}
      />,
    )
    const select = container.querySelector(
      'select[name="conditions.0.sourceId"]',
    ) as HTMLSelectElement
    expect(select.getAttribute("data-component")).toBe("combobox")
    // The field mock renders top-level options only: the stage picker passes
    // pipeline GROUPS whose children are the stages, so a pipeline id is never
    // a selectable value here.
    expect(
      Array.from(select.querySelectorAll("option")).map((option) =>
        option.getAttribute("value"),
      ),
    ).toEqual(["pipeline:pipe-1"])
  })
})
