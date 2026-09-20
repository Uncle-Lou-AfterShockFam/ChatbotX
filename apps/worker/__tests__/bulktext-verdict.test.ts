import { beforeEach, describe, expect, test, vi } from "vitest"

const { mockResolve, mockSetValue, mockAttach, mockDetach } = vi.hoisted(
  () => ({
    mockResolve: vi.fn(),
    mockSetValue: vi.fn().mockResolvedValue(undefined),
    mockAttach: vi.fn().mockResolvedValue(undefined),
    mockDetach: vi.fn().mockResolvedValue(undefined),
  }),
)

vi.mock("@chatbotx.io/business", () => ({
  customFieldService: { resolveByNameAndType: mockResolve },
  contactCustomFieldService: { setValueByKey: mockSetValue },
  tagService: {
    attachByNamesToContacts: mockAttach,
    detachByNamesFromContacts: mockDetach,
  },
}))

const { applyBulktextVerdict, bulktextVerdictFor, isBulktextLine } =
  await import("../src/integration/handlers/bulktext-verdict")

const contactInbox = { id: "ci-1", inboxId: "inbox-1", channel: "api" }
const base = { workspaceId: "ws-1", contactId: "c-1", contactInbox }

describe("bulktextVerdictFor (pure)", () => {
  test("delivered = send; a known gate reason = skip; anything else = no verdict", () => {
    expect(bulktextVerdictFor("delivered", undefined)).toEqual({
      verdict: "send",
      reason: "",
    })
    expect(bulktextVerdictFor("failed", "no-reply-streak")).toEqual({
      verdict: "skip",
      reason: "no-reply-streak",
    })
    expect(bulktextVerdictFor("failed", "stop-reply")).toEqual({
      verdict: "skip",
      reason: "stop-reply",
    })
    expect(bulktextVerdictFor("failed", "FillNumberInput")).toBeNull()
    expect(bulktextVerdictFor("failed", { reason: "stop-reply" })).toBeNull()
    expect(bulktextVerdictFor("failed", undefined)).toBeNull()
    expect(bulktextVerdictFor("read", undefined)).toBeNull()
  })
})

describe("applyBulktextVerdict", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockResolve.mockResolvedValue({
      idMap: new Map([
        ["shortText:bt_verdict", "f-verdict"],
        ["shortText:bt_reason", "f-reason"],
      ]),
      createdIds: [],
    })
  })

  test("skip: writes verdict + reason by resolved field id and tags bt-blocked", async () => {
    await expect(
      applyBulktextVerdict({
        ...base,
        status: "failed",
        error: "no-reply-streak",
      }),
    ).resolves.toBe("skip")
    expect(mockResolve).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      fields: [
        { name: "bt_verdict", type: "shortText" },
        { name: "bt_reason", type: "shortText" },
      ],
    })
    expect(mockSetValue.mock.calls.map(([c]) => [c.keyword, c.value])).toEqual([
      ["f-verdict", "skip"],
      ["f-reason", "no-reply-streak"],
    ])
    expect(mockAttach).toHaveBeenCalledWith(
      expect.objectContaining({
        contactIds: ["c-1"],
        names: ["bt-blocked"],
        contactInbox,
      }),
    )
    expect(mockDetach).not.toHaveBeenCalled()
  })

  test("send: writes send + empty reason and removes bt-blocked", async () => {
    await expect(
      applyBulktextVerdict({ ...base, status: "delivered", error: undefined }),
    ).resolves.toBe("send")
    expect(mockSetValue.mock.calls.map(([c]) => [c.keyword, c.value])).toEqual([
      ["f-verdict", "send"],
      ["f-reason", ""],
    ])
    expect(mockDetach).toHaveBeenCalledWith(
      expect.objectContaining({ contactIds: ["c-1"], names: ["bt-blocked"] }),
    )
    expect(mockAttach).not.toHaveBeenCalled()
  })

  test("a provider failure that is not a gate verdict touches nothing", async () => {
    await expect(
      applyBulktextVerdict({
        ...base,
        status: "failed",
        error: "smtp-rejected",
      }),
    ).resolves.toBeNull()
    expect(mockResolve).not.toHaveBeenCalled()
    expect(mockSetValue).not.toHaveBeenCalled()
  })

  test("a field-resolution failure propagates (the caller logs, the status stays recorded)", async () => {
    mockResolve.mockRejectedValue(new Error("db down"))
    await expect(
      applyBulktextVerdict({ ...base, status: "delivered", error: undefined }),
    ).rejects.toThrow("db down")
  })
})

describe("isBulktextLine (scope of the verdict writer)", () => {
  test("a bulktext callback URL or a bulktext-<line> name qualifies; any other API-channel integration does not", () => {
    expect(
      isBulktextLine({
        name: "bulktext-gv",
        callbackUrl: "https://x.ngrok-free.dev/api/hooks/chatbotx?platform=gv",
      }),
    ).toBe(true)
    expect(
      isBulktextLine({ name: "bulktext-imessage", callbackUrl: null }),
    ).toBe(true)
    expect(
      isBulktextLine({
        name: "Acme CRM bridge",
        callbackUrl: "https://acme.example/api/hooks/chatbotx",
      }),
    ).toBe(true)
    expect(
      isBulktextLine({
        name: "Acme CRM bridge",
        callbackUrl: "https://acme.example/webhook",
      }),
    ).toBe(false)
    expect(isBulktextLine({ name: "other", callbackUrl: null })).toBe(false)
    expect(isBulktextLine(null)).toBe(false)
    expect(isBulktextLine({})).toBe(false)
  })
})
