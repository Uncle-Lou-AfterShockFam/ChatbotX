// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { useContactFilterQueryState } from "@/features/contact-filter/components/use-contact-filter-query-state"

const mockReplace = vi.fn()
// Stable like Next's own router: the hook's effect depends on it.
const router = { replace: mockReplace }
let search = ""

vi.mock("next/navigation", () => ({
  usePathname: () => "/space/ws-1/contacts",
  useRouter: () => router,
  useSearchParams: () => new URLSearchParams(search),
}))

type HookState = ReturnType<typeof useContactFilterQueryState>
const renders: HookState[] = []

function HookHost() {
  renders.push(useContactFilterQueryState())
  return null
}

const VALID = {
  operator: "and",
  conditions: [{ field: "fullName", operator: "isNotEmpty" }],
}

describe("useContactFilterQueryState (s206: an invalid filter never widens)", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    mockReplace.mockClear()
    renders.length = 0
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

  const mount = (query: string) => {
    search = query
    act(() => {
      root.render(<HookHost />)
    })
  }

  test.each([
    ["malformed JSON", "contactFilter=%7Bbad&keyword=ann"],
    ["a repeated param", "contactFilter=%7B%7D&contactFilter=%7B%7D"],
  ])("%s is invalid from the FIRST render and keeps the URL", (_label, query) => {
    mount(query)

    // The first render already knows, so the table never fetches everyone.
    expect(renders[0]?.invalid).toBe(true)
    expect(renders.at(-1)?.invalid).toBe(true)
    expect(renders.at(-1)?.isActive).toBe(false)
    expect(mockReplace).not.toHaveBeenCalled()
  })

  test("clearInvalidFilter drops only the contactFilter param", () => {
    mount("contactFilter=%7Bbad&keyword=ann")

    act(() => {
      renders.at(-1)?.clearInvalidFilter()
    })

    expect(mockReplace).toHaveBeenCalledWith(
      "/space/ws-1/contacts?keyword=ann",
      {
        scroll: false,
      },
    )
  })

  test("a valid filter moves into state and the URL is cleaned", () => {
    mount(`contactFilter=${encodeURIComponent(JSON.stringify(VALID))}`)

    expect(renders.at(-1)?.invalid).toBe(false)
    expect(renders.at(-1)?.filter).toEqual(VALID)
    expect(mockReplace).toHaveBeenCalledWith("/space/ws-1/contacts", {
      scroll: false,
    })
  })

  test("no param is neither invalid nor active", () => {
    mount("")

    expect(renders.at(-1)?.invalid).toBe(false)
    expect(renders.at(-1)?.isActive).toBe(false)
  })
})
