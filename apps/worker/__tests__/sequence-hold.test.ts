import { beforeEach, expect, test, vi } from "vitest"

const getAll = vi.fn()
const resolveMapping = vi.fn()
vi.mock("@chatbotx.io/variables", () => ({
  contactVariableService: {
    getAll: (...args: unknown[]) => getAll(...args),
    resolveMapping: (...args: unknown[]) => resolveMapping(...args),
  },
}))

import { missingHoldFields } from "../src/integration/handlers/sequence-hold"

beforeEach(() => {
  getAll.mockReset().mockResolvedValue({ contact: {} })
  resolveMapping.mockReset()
})

test("s227b: a field is missing when unresolved, empty or whitespace", async () => {
  resolveMapping.mockResolvedValueOnce({
    first_name: "Ada",
    company: "   ",
    city: "",
  })
  const missing = await missingHoldFields({
    holdOnMissing: ["first_name", "company", "city", "Favourite colour"],
    contactId: "c-1",
    contactInboxId: "ci-1",
  })
  expect(missing).toEqual(["company", "city", "Favourite colour"])
  expect(getAll).toHaveBeenCalledWith({
    contactId: "c-1",
    contactInbox: "ci-1",
  })
  expect(resolveMapping).toHaveBeenCalledWith({
    text: "{{first_name}} {{company}} {{city}} {{Favourite colour}}",
    variables: { contact: {} },
  })
})

test("s227b: no hold fields resolves nothing (no contact load)", async () => {
  for (const holdOnMissing of [null, undefined, []]) {
    expect(
      await missingHoldFields({
        holdOnMissing,
        contactId: "c-1",
        contactInboxId: "ci-1",
      }),
    ).toEqual([])
  }
  expect(getAll).not.toHaveBeenCalled()
})
