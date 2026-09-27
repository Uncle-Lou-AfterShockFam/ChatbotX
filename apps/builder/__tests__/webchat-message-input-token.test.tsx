import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, test, vi } from "vitest"

// s210 probe: react-hook-form caches defaultValues at mount, so a refreshed
// guest token never reached a text send and every send after a long idle
// 403'd (the optimistic bubble was lost). Real useForm; only the safe-action
// adapter is thinned to "submit = record the form values".
const submitted = vi.hoisted(() => [] as Record<string, unknown>[])
vi.mock("@next-safe-action/adapter-react-hook-form/hooks", async () => {
  const { useForm } = await import("react-hook-form")
  return {
    useHookFormAction: (
      _action: unknown,
      _resolver: unknown,
      options: { formProps: Parameters<typeof useForm>[0] },
    ) => {
      const form = useForm(options.formProps)
      return {
        form,
        handleSubmitWithAction: () => {
          submitted.push({ ...form.getValues() })
          return Promise.resolve()
        },
        resetFormAndAction: () => undefined,
      }
    },
  }
})
vi.mock("@/features/messages/actions/create-webchat-message.action", () => ({
  createWebchatMessageAction: {},
}))
vi.mock("@/features/messages/components/emoji-picker", () => ({
  default: () => null,
}))
vi.mock("@/features/messages/components/file-upload", () => ({
  FileUploadPreview: () => null,
}))
vi.mock(
  "@/features/integration-webchat/components/webchat-message-menu",
  () => ({
    default: () => null,
  }),
)

const freshAccessToken = vi.hoisted(() => vi.fn<() => Promise<string | null>>())
vi.mock(
  "@/features/integration-webchat/providers/store/guest-session-provider",
  () => ({
    useGuestSessionStore: (select: (s: unknown) => unknown) =>
      select({
        sendMessage: vi.fn(),
        appendMessage: vi.fn(),
        guestConversationId: "123:0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f",
        freshAccessToken,
      }),
  }),
)

const { WebchatMessageInput } = await import(
  "@/features/integration-webchat/webchat-message-input"
)

let root: Root | undefined
let container: HTMLDivElement | undefined
afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  submitted.length = 0
  freshAccessToken.mockReset()
})

const render = (accessToken: string) =>
  act(() => {
    root?.render(
      <WebchatMessageInput
        accessToken={accessToken}
        parentOrigin="shop.example"
        webchatId="42"
        workspaceId="1"
      />,
    )
  })

const submit = async () => {
  const form = container?.querySelector("form")
  await act(async () => {
    form?.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    )
    await Promise.resolve()
  })
}

describe("webchat text send uses the current guest token (s210)", () => {
  test("a token refreshed after mount is the one sent", async () => {
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    // freshAccessToken returns what the store holds: the prop's latest value.
    let current = "OLD"
    freshAccessToken.mockImplementation(async () => current)
    render("OLD")
    current = "NEW"
    render("NEW")
    await submit()
    expect(submitted.at(-1)?.accessToken).toBe("NEW")
  })

  test("a due token is refreshed before the send", async () => {
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    freshAccessToken.mockResolvedValue("FRESH")
    render("OLD")
    await submit()
    expect(freshAccessToken).toHaveBeenCalledTimes(1)
    expect(submitted.at(-1)?.accessToken).toBe("FRESH")
  })
})
