import { beforeEach, describe, expect, test, vi } from "vitest"

const { resolveDeep } = vi.hoisted(() => ({ resolveDeep: vi.fn() }))

vi.mock("@chatbotx.io/variables", () => ({
  resolveContactVariablesDeep: resolveDeep,
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
  })

  test("resolves {{variables}} once, for this contact, trimmed", async () => {
    resolveDeep.mockResolvedValueOnce(" 3635 ")
    await expect(
      resolveWaitMatchValue(
        step("{{raw:wp_order_id}}"),
        contactInbox,
        conversation,
      ),
    ).resolves.toBe("3635")
    expect(resolveDeep).toHaveBeenCalledWith(
      "contact-1",
      "{{raw:wp_order_id}}",
      { contactInbox, conversation },
    )
  })

  test("a literal, empty, or non-event matchValue needs no resolution (undefined = use the step value)", async () => {
    await expect(
      resolveWaitMatchValue(step("3635"), contactInbox, conversation),
    ).resolves.toBeUndefined()
    await expect(
      resolveWaitMatchValue(step(""), contactInbox, conversation),
    ).resolves.toBeUndefined()
    await expect(
      resolveWaitMatchValue(
        {
          ...(step("{{raw:wp_order_id}}") as object),
          delayType: "duration",
        } as never,
        contactInbox,
        conversation,
      ),
    ).resolves.toBeUndefined()
    expect(resolveDeep).not.toHaveBeenCalled()
  })

  test("fails closed to '' when the value is empty or still a placeholder", async () => {
    resolveDeep.mockResolvedValueOnce("   ")
    await expect(
      resolveWaitMatchValue(
        step("{{raw:wp_order_id}}"),
        contactInbox,
        conversation,
      ),
    ).resolves.toBe("")
    resolveDeep.mockResolvedValueOnce("{{raw:wp_order_id}}")
    await expect(
      resolveWaitMatchValue(
        step("{{raw:wp_order_id}}"),
        contactInbox,
        conversation,
      ),
    ).resolves.toBe("")
  })

  test("a lookup failure throws (the job retries) instead of parking an unmatchable wait", async () => {
    resolveDeep.mockRejectedValueOnce(new Error("db down"))
    await expect(
      resolveWaitMatchValue(
        step("{{raw:wp_order_id}}"),
        contactInbox,
        conversation,
      ),
    ).rejects.toThrow("db down")
  })
})
