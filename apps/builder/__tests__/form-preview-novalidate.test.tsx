// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server"
import { expect, test, vi } from "vitest"

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const BARE_REQUIRED = /\srequired[\s=>"]/

const { FormPreview } = await import(
  "../src/features/forms/components/form-preview"
)

/**
 * s200 live proof B4: the browser's native required tooltip fired before the
 * form's own message. The form opts out of constraint validation and marks
 * required inputs with aria-required only, so the evaluator's issue text is
 * what the submitter sees.
 */
test("the preview form disables native validation and never sets `required` on inputs", () => {
  const html = renderToStaticMarkup(
    <FormPreview
      definition={{
        steps: [
          {
            id: "s1",
            title: "",
            fields: [
              { key: "email", type: "email", label: "Email", required: true },
              {
                key: "notes",
                type: "textarea",
                label: "Notes",
                required: true,
              },
            ],
          },
        ],
        rules: [],
      }}
      onSubmit={() => undefined}
      submitLabel="Send"
    />,
  )
  expect(html.toLowerCase()).toContain("novalidate")
  expect(html).not.toMatch(BARE_REQUIRED)
  expect(html.match(/aria-required="true"/g)?.length).toBe(2)
})
