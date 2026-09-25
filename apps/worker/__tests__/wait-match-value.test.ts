import { beforeEach, describe, expect, test, vi } from "vitest"

const { getAll, replaceAll } = vi.hoisted(() => ({
  getAll: vi.fn(),
  replaceAll: vi.fn(),
}))

vi.mock("@chatbotx.io/variables", () => ({
  contactVariableService: { getAll, replaceAll },
}))
vi.mock("../src/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn() },
}))

const { resolveWaitMatchValue } = await import(
  "../src/integration/handlers/wait-match-value"
)

const step = (matchValue: string) =>
  ({
    id: "step-1",
    stepType: "wait",
    delayType: "event",
    eventType: "customFieldChanged",
    tagId: "",
    customFieldId: "cf-paid",
    matchValue,
    timeoutValue: 1,
    timeoutUnit: "days",
    states: [],
  }) as never
const contactInbox = { id: "ci-1", contactId: "contact-1" } as never
const conversation = { id: "conv-1" } as never

describe("resolveWaitMatchValue", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getAll.mockResolvedValue({})
  })

  test("resolves {{variables}} once, for this contact, trimmed", async () => {
    replaceAll.mockResolvedValueOnce(" 3635 ")
    await expect(
      resolveWaitMatchValue(
        step("{{raw:wp_order_id}}"),
        contactInbox,
        conversation,
      ),
    ).resolves.toBe("3635")
    expect(getAll).toHaveBeenCalledWith({
      contactId: "contact-1",
      contactInbox,
      conversation,
    })
  })

  test("a literal or empty matchValue needs no resolution (undefined = use the step value)", async () => {
    await expect(
      resolveWaitMatchValue(step("3635"), contactInbox, conversation),
    ).resolves.toBeUndefined()
    await expect(
      resolveWaitMatchValue(step(""), contactInbox, conversation),
    ).resolves.toBeUndefined()
    expect(getAll).not.toHaveBeenCalled()
  })

  test("fails closed to '' when the value is empty, still a placeholder, or resolution throws", async () => {
    replaceAll.mockResolvedValueOnce("   ")
    await expect(
      resolveWaitMatchValue(
        step("{{raw:wp_order_id}}"),
        contactInbox,
        conversation,
      ),
    ).resolves.toBe("")
    replaceAll.mockResolvedValueOnce("{{raw:wp_order_id}}")
    await expect(
      resolveWaitMatchValue(
        step("{{raw:wp_order_id}}"),
        contactInbox,
        conversation,
      ),
    ).resolves.toBe("")
    getAll.mockRejectedValueOnce(new Error("db down"))
    await expect(
      resolveWaitMatchValue(
        step("{{raw:wp_order_id}}"),
        contactInbox,
        conversation,
      ),
    ).resolves.toBe("")
  })
})
