import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, test, vi } from "vitest"

/**
 * s222b: "Sign Out" in the user menu did nothing (no request, session intact).
 * The confirm dialog was mounted INSIDE the dropdown and unmounted with it.
 * The menu now opens a controlled dialog that lives outside the menu.
 */
const signOut = vi.fn()
const push = vi.fn()
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }))
vi.mock("@/lib/auth/auth-client", () => ({
  authClient: {
    signOut: (opts: { fetchOptions: { onSuccess: () => void } }) => {
      signOut(opts)
      opts.fetchOptions.onSuccess()
      return Promise.resolve()
    },
  },
}))

const { SignOut } = await import("@/features/auth/sign-out")

let container: HTMLDivElement | null = null
let root: Root | null = null
const render = (node: React.ReactNode) => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root?.render(node))
}
afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  signOut.mockClear()
  push.mockClear()
})

const buttons = () => Array.from(document.body.querySelectorAll("button"))

describe("SignOut dialog", () => {
  test("controlled + open: the confirm dialog shows without any trigger, and confirming signs out then goes to sign-in", async () => {
    render(<SignOut onOpenChange={() => undefined} open />)
    expect(document.body.textContent).toContain("messages.signOutConfirmation")
    const confirm = buttons().find((b) => b.textContent === "actions.signOut")
    expect(confirm).toBeDefined()
    await act(async () => {
      confirm?.click()
      await Promise.resolve()
    })
    expect(signOut).toHaveBeenCalledOnce()
    expect(push).toHaveBeenCalledWith("/auth/sign-in")
  })

  test("controlled + closed renders nothing (the menu item opens it)", () => {
    render(<SignOut onOpenChange={() => undefined} open={false} />)
    expect(document.body.textContent).not.toContain("actions.signOut")
  })

  test("uncontrolled keeps its own trigger (the account rail)", () => {
    render(<SignOut />)
    expect(buttons().some((b) => b.textContent === "actions.signOut")).toBe(
      true,
    )
    expect(document.body.textContent).not.toContain(
      "messages.signOutConfirmation",
    )
  })
})
