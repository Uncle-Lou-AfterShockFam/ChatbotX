import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, test, vi } from "vitest"

// s212: two ways the dashboards printed the wrong day.
// 1. A server-resolved day key (`dateReport`, "YYYY-MM-DD" in the viewer's
//    zone) was wrapped in `new Date()`, which reads it as UTC midnight: the
//    day BEFORE for every viewer west of UTC. The formatter must get the key.
// 2. An instant (`occurredAt`) was formatted in the runtime's zone (UTC on the
//    server): it must be the viewer's zone, which SSR and hydration share.
const VIEWER_ZONE = "America/New_York"
const formatDateWithYear = vi.hoisted(() =>
  vi.fn((..._args: unknown[]) => "formatted"),
)
vi.mock("../src/utils/date-format", () => ({ formatDateWithYear }))
vi.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => (key: string) => key,
  useTimeZone: () => VIEWER_ZONE,
}))
const state = vi.hoisted(() => ({
  refLinkStats: [{ dateReport: "2026-09-20", count: 1 }],
  magicLinkStats: [{ dateReport: "2026-09-20", count: 1 }],
  reflinkContacts: [] as unknown[],
  reflinkContactsPage: 1,
  reflinkContactsPageCount: 1,
  magicLinkContacts: [] as unknown[],
  magicLinkContactsPage: 1,
  magicLinkContactsPageCount: 1,
  setReflinkContactsPage: () => undefined,
  setMagicLinkContactsPage: () => undefined,
  loading: false,
}))
vi.mock("../src/provider/analysis-store-context", () => ({
  useAnalysisStore: (select: (s: typeof state) => unknown) => select(state),
}))

const contact = {
  contactInboxId: "ci-1",
  occurredAt: "2026-09-20T02:00:00.000Z",
  firstName: "Ada",
  lastName: null,
  avatar: null,
  sourceId: null,
}
state.reflinkContacts = [contact]
state.magicLinkContacts = [contact]

const { ReflinkStatsTable } = await import(
  "../src/components/charts/reflink-stats-table"
)
const { MagicLinkStatsTable } = await import(
  "../src/components/charts/magic-link-stats-table"
)
const { ReflinkContactsTable } = await import(
  "../src/components/charts/reflink-contacts-table"
)
const { MagicLinkContactsTable } = await import(
  "../src/components/charts/magic-link-contacts-table"
)

let root: Root | undefined
let container: HTMLDivElement | undefined
afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  formatDateWithYear.mockClear()
})

const render = (ui: React.ReactNode) => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root?.render(ui))
}

describe("dashboard dates (s212)", () => {
  test.each([
    ["reflink", ReflinkStatsTable],
    ["magic link", MagicLinkStatsTable],
  ])("the %s stats table formats the day key itself, never a UTC-midnight Date", (_, Table) => {
    render(<Table />)
    expect(formatDateWithYear).toHaveBeenCalledWith("2026-09-20", "en")
  })

  test.each([
    ["reflink", ReflinkContactsTable],
    ["magic link", MagicLinkContactsTable],
  ])("the %s contacts table formats occurredAt in the viewer's zone", (_, Table) => {
    render(<Table />)
    expect(formatDateWithYear).toHaveBeenCalledWith(
      new Date(contact.occurredAt),
      "en",
      VIEWER_ZONE,
    )
  })
})
