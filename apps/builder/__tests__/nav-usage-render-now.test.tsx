import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, test, vi } from "vitest"

// s212: NavUsage counted trial days from Date.now() at render, so SSR and
// hydration straddling a day boundary disagreed (a latent React #418 for
// trial accounts). It must count from the render clock (useRenderNow), which
// the server render and hydration share.
const RENDER_NOW = new Date("2026-09-27T12:00:00Z")
vi.mock("@/hooks/use-render-now", () => ({ useRenderNow: () => RENDER_NOW }))
vi.mock("@chatbotx.io/ui/components/ui/sidebar", () => ({
  useSidebar: () => ({ state: "expanded", isMobile: false }),
}))
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))
vi.mock("@/enterprise/features/billing/upgrade-plan-dialog", () => ({
  UpgradePlanButton: () => null,
}))

const { NavUsage } = await import("@/components/nav-usage")

let root: Root | undefined
let container: HTMLDivElement | undefined
afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  vi.useRealTimers()
})

describe("NavUsage trial countdown (s212)", () => {
  test("counts days from the render clock, not the machine clock", () => {
    // The machine clock is a day past the render clock.
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-09-28T12:00:00Z"))
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root?.render(
        <NavUsage
          metrics={[]}
          planStatus="trial"
          trialEndsAt="2026-09-30T12:00:00Z"
        />,
      )
    })
    // 3 days from the render clock (2 from the machine clock).
    expect(container.textContent).toContain('billing.trial.daysLeft:{"days":3}')
  })
})
