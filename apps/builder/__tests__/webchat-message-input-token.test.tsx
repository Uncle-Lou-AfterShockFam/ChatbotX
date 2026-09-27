import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, test, vi } from "vitest"

// s210 probe: react-hook-form caches defaultValues at mount, so a refreshed
// guest token never reached a text send and every send after a long idle
// 403'd (the optimistic bubble was lost). Real useForm; only the safe-action
// adapter is thinned to "submit = record the form values".
const submitted = vi.hoisted(() => [] as Record<string, unknown>[])
const hook = vi.hoisted(() => ({
  actionProps: {} as {
    onError?: (args: {
      error: { serverError?: unknown }
      input: Record<string, unknown>
    }) => void
  },
  form: null as null | {
    getValues: (name?: string) => unknown
    setValue: (name: string, value: unknown) => void
  },
}))
vi.mock("@next-safe-action/adapter-react-hook-form/hooks", async () => {
  const { useForm } = await import("react-hook-form")
  return {
    useHookFormAction: (
      _action: unknown,
      _resolver: unknown,
      options: {
        formProps: Parameters<typeof useForm>[0]
        actionProps: typeof hook.actionProps
      },
    ) => {
      const form = useForm(options.formProps)
      hook.actionProps = options.actionProps
      hook.form = form as never
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
const markSendFailed = vi.hoisted(() => vi.fn())
vi.mock(
  "@/features/integration-webchat/providers/store/guest-session-provider",
  () => ({
    useGuestSessionStore: (select: (s: unknown) => unknown) =>
      select({
        sendMessage: vi.fn(),
        appendMessage: vi.fn(),
        guestConversationId: "123:0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f",
        freshAccessToken,
        markSendFailed,
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
  markSendFailed.mockReset()
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

  test("Enter + click while the token is refreshing sends once", async () => {
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    let release: (token: string) => void = () => undefined
    freshAccessToken.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    render("OLD")
    const form = container.querySelector("form")
    await act(async () => {
      form?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      )
      form?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      )
      await Promise.resolve()
    })
    await act(async () => {
      release("FRESH")
      await Promise.resolve()
    })
    expect(freshAccessToken).toHaveBeenCalledTimes(1)
    expect(submitted).toHaveLength(1)
  })

  test("a send that does not land flags its bubble, gives the text back, and takes a new clientId (s212)", async () => {
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    render("OLD")
    const before = hook.form?.getValues("clientId")
    await act(async () => {
      hook.actionProps.onError?.({
        error: { serverError: "Not authorized" },
        input: { text: "hello", clientId: before },
      })
      await Promise.resolve()
    })
    expect(markSendFailed).toHaveBeenCalledWith(before, "Not authorized")
    expect(hook.form?.getValues("text")).toBe("hello")
    expect(hook.form?.getValues("clientId")).not.toBe(before)
  })

  test("text the visitor typed since is never overwritten (s212)", async () => {
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    render("OLD")
    await act(async () => {
      hook.form?.setValue("text", "newer")
      hook.actionProps.onError?.({
        error: {},
        input: { text: "hello", clientId: "c1" },
      })
      await Promise.resolve()
    })
    expect(markSendFailed).toHaveBeenCalledWith("c1", "Network error")
    expect(hook.form?.getValues("text")).toBe("newer")
  })
})
