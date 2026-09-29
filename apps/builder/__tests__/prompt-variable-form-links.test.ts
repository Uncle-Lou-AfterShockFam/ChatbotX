import { describe, expect, test, vi } from "vitest"

vi.mock("@/features/forms/provider/form-hooks", () => ({ useForms: vi.fn() }))
vi.mock("@/hooks/routing", () => ({ useWorkspaceId: () => "1" }))

const { buildFormLinkPromptVariableOptions } = await import(
  "@/components/tiptap/use-prompt-variable-options"
)

describe("form link variable options (s220c A2-4)", () => {
  test("only PUBLISHED forms are offered, as opaque form_link:<id> tokens labelled by title", () => {
    expect(
      buildFormLinkPromptVariableOptions(
        [
          { id: "11", title: "Intake", status: "published" },
          { id: "12", title: "Draft one", status: "draft" },
          { id: "13", title: "Old", status: "archived" },
        ],
        "Form links",
      ),
    ).toEqual([{ group: "Form links", label: "Intake", value: "form_link:11" }])
  })
})
