// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server"
import { expect, test, vi } from "vitest"

vi.mock("@/hooks/routing", () => ({ useWorkspaceId: () => "1" }))
vi.mock("@/features/email-templates/provider/email-template-hooks", () => ({
  useEmailTemplates: () => ({ data: [{ id: "42", name: "October news" }] }),
}))
vi.mock("@/features/flows/react-flow/components/page-element-builder", () => ({
  PageElementViewer: () => <p>legacy-element</p>,
}))

const { default: EmailStepViewer } = await import(
  "@/features/flows/react-flow/steps/email/viewer"
)

const step = (extra: object) =>
  ({
    subject: "Hi",
    elements: [{ id: "1", type: "text" }],
    ...extra,
  }) as never

test("s221b: a template step shows the template's name, not the legacy elements", () => {
  const html = renderToStaticMarkup(
    <EmailStepViewer data={step({ templateId: "42" })} />,
  )
  expect(html).toContain("October news")
  expect(html).not.toContain("legacy-element")
})

test("an unknown template id still says which template it points at", () => {
  const html = renderToStaticMarkup(
    <EmailStepViewer data={step({ templateId: "9" })} />,
  )
  expect(html).toContain("#9")
})

test("without a template the elements render as before", () => {
  const html = renderToStaticMarkup(<EmailStepViewer data={step({})} />)
  expect(html).toContain("legacy-element")
})
