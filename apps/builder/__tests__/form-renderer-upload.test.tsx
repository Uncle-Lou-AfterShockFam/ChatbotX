import {
  evaluateForm,
  type FormValues,
  formDefinition,
} from "@chatbotx.io/utils/form"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, test, vi } from "vitest"
import {
  FormRenderer,
  type FormUploadHandler,
} from "@/features/forms/components/form-renderer"

/** s225a A2-4 PR 5: a photo / file field sends its file, then holds the id. */
const DEF = formDefinition.parse({
  steps: [
    {
      id: "s1",
      fields: [
        { key: "photo", type: "image", label: "Photo" },
        { key: "doc", type: "file", label: "Doc", maxSizeMb: 1 },
      ],
    },
  ],
  rules: [],
})
const UPLOAD_ID = /^fu_/
const LABELS = {
  uploading: "Uploading",
  tooLarge: "Too large",
  failed: "Failed",
  previewOnly: "Preview only",
}

let container: HTMLDivElement | null = null
let root: Root | null = null

const render = (upload: FormUploadHandler, values: FormValues = {}) => {
  const onChange = vi.fn()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(
      <FormRenderer
        definition={DEF}
        evaluation={evaluateForm(DEF, values)}
        idPrefix="t"
        issues={[]}
        messages={{} as never}
        onChange={onChange}
        stepId="s1"
        upload={upload}
        values={values}
      />,
    )
  })
  return { el: container, onChange }
}

const pick = async (input: HTMLInputElement, file: File) => {
  Object.defineProperty(input, "files", { value: [file], configurable: true })
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }))
    await Promise.resolve()
  })
}

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

describe("upload fields", () => {
  test("a picked file is sent and the field takes the returned id", async () => {
    const send = vi
      .fn()
      .mockResolvedValue({ ok: true, uploadId: "fu_x", name: "me.png" })
    const onBusy = vi.fn()
    const { el, onChange } = render({ send, onBusy, labels: LABELS })
    const input = el.querySelector<HTMLInputElement>("#t-photo")
    expect(input?.accept).toBe("image/jpeg,image/png,image/gif,image/webp")
    const file = new File([new Uint8Array([1])], "me.png")
    await pick(input as HTMLInputElement, file)
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ key: "photo" }),
      file,
    )
    expect(onChange).toHaveBeenLastCalledWith("photo", "fu_x")
    expect(onBusy.mock.calls).toEqual([[1], [-1]])
    expect(
      el.querySelector('[data-testid="t-photo-upload-done"]')?.textContent,
    ).toContain("me.png")
  })

  test("a file over the field's cap is refused before any request", async () => {
    const send = vi.fn()
    const { el, onChange } = render({ send, labels: LABELS })
    const input = el.querySelector<HTMLInputElement>("#t-doc")
    expect(input?.accept).toContain("application/pdf")
    await pick(
      input as HTMLInputElement,
      new File([new Uint8Array(1024 * 1024 + 1)], "big.pdf"),
    )
    expect(send).not.toHaveBeenCalled()
    expect(onChange).toHaveBeenLastCalledWith("doc", "")
    expect(
      el.querySelector('[data-testid="t-doc-upload-error"]')?.textContent,
    ).toBe("Too large")
  })

  test("a refused upload shows its message and leaves the field empty", async () => {
    const send = vi.fn().mockResolvedValue({ ok: false, message: "Nope" })
    const { el, onChange } = render({ send, labels: LABELS })
    await pick(
      el.querySelector<HTMLInputElement>("#t-photo") as HTMLInputElement,
      new File([new Uint8Array([1])], "x.exe"),
    )
    expect(onChange).not.toHaveBeenCalledWith(
      "photo",
      expect.stringMatching(UPLOAD_ID),
    )
    expect(
      el.querySelector('[data-testid="t-photo-upload-error"]')?.textContent,
    ).toBe("Nope")
  })

  test("without a sender (the editor preview) the picker is disabled", () => {
    const { el } = render({ labels: LABELS })
    expect(el.querySelector<HTMLInputElement>("#t-photo")?.disabled).toBe(true)
    expect(el.textContent).toContain("Preview only")
  })
})
