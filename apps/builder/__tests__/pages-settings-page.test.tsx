// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server"
import { expect, test, vi } from "vitest"
import { createStore } from "zustand/vanilla"

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("notFound")
  }),
}))
vi.mock("@/lib/auth/require-workspace-permission", () => ({
  requireContactsAccess: vi.fn(async () => undefined),
}))
vi.mock("@/features/custom-fields/provider/custom-field-store", () => ({
  createCustomFieldStore: () =>
    createStore(() => ({
      ready: "store-mounted",
      initialize: () => undefined,
    })),
}))
// Stands in for the rich-text "Insert field" picker, which reads the
// custom-field store: without the provider it throws (s199 live crash).
vi.mock("@/features/pages/components/pages-settings", async () => {
  const { useCustomFieldStore } = await import(
    "@/features/custom-fields/provider/custom-field-store-context"
  )
  return {
    PagesSettings: () => {
      const ready = useCustomFieldStore(
        (s) => (s as unknown as { ready: string }).ready,
      )
      return <p>{ready}</p>
    },
  }
})

test("s227a: Settings > Pages mounts the custom-field store the editor needs", async () => {
  const { default: PagesSettingsPage } = await import(
    "@/app/space/[workspaceId]/(settings)/settings/pages/page"
  )
  const element = await PagesSettingsPage({
    params: Promise.resolve({ workspaceId: "11701868563365888" }),
  })
  expect(renderToStaticMarkup(element)).toContain("store-mounted")
})
