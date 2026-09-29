import {
  evaluateForm,
  type FormValues,
  formDefinition,
} from "@chatbotx.io/utils/form"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, test, vi } from "vitest"
import { FormRenderer } from "@/features/forms/components/form-renderer"

/** s220c A2-4: the slider and the rating on the public page / preview. */
const DEF = formDefinition.parse({
  steps: [
    {
      id: "s1",
      fields: [
        {
          key: "mood",
          type: "slider",
          label: "Mood",
          min: 0,
          max: 10,
          step: 2,
        },
        { key: "stars", type: "rating", label: "Stars", max: 4 },
      ],
    },
  ],
  rules: [],
})

let container: HTMLDivElement | null = null
let root: Root | null = null

const render = (values: FormValues, onChange = vi.fn()) => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(
      <FormRenderer
        definition={DEF}
        evaluation={evaluateForm(DEF, values)}
        idPrefix="t"
        issues={[]}
        messages={{} as never}
        onChange={onChange}
        stepId="s1"
        values={values}
      />,
    )
  })
  return { el: container, onChange }
}

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

describe("slider + rating inputs (s220c A2-4)", () => {
  test("an untouched slider reads '-' and carries its bounds and step; moving it reports a NUMBER", () => {
    const { el, onChange } = render({})
    const range = el.querySelector<HTMLInputElement>("#t-mood")
    expect(range?.type).toBe("range")
    expect([range?.min, range?.max, range?.step]).toEqual(["0", "10", "2"])
    expect(el.querySelector('[data-testid="t-mood-value"]')?.textContent).toBe(
      "-",
    )
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set
      setter?.call(range, "6")
      range?.dispatchEvent(new Event("input", { bubbles: true }))
    })
    expect(onChange).toHaveBeenCalledWith("mood", 6)
  })

  test("the rating is max native radios in one group; choosing reports the star as a NUMBER", () => {
    const { el, onChange } = render({ stars: 2 })
    const radios = el.querySelectorAll<HTMLInputElement>(
      '#t-stars input[type="radio"]',
    )
    expect(radios).toHaveLength(4)
    expect(new Set(Array.from(radios, (r) => r.name)).size).toBe(1)
    expect(Array.from(radios, (r) => r.checked)).toEqual([
      false,
      true,
      false,
      false,
    ])
    expect(radios[2]?.getAttribute("aria-label")).toBe("3/4")
    act(() => radios[2]?.click())
    expect(onChange).toHaveBeenCalledWith("stars", 3)
  })
})
