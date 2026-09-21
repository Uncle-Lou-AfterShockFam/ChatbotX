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
    expect(bulktextVerdictFor("failed", "bad-number")).toEqual({
      verdict: "unreachable",
      reason: "bad-number",
    })
    expect(bulktextVerdictFor("failed", "hard-bounce")).toEqual({
      verdict: "unreachable",
      reason: "hard-bounce",
    })
    expect(bulktextVerdictFor("failed", "line-error")).toEqual({
      verdict: "error",
      reason: "line-error",
    })
    expect(bulktextVerdictFor("failed", "canceled")).toEqual({
      verdict: "error",
      reason: "canceled",
    })
    // Anything else with text = a line error the operator must see (skeptic
    // s172: pull-mode refusal reasons such as bad-options / media-fetch).
    expect(bulktextVerdictFor("failed", "FillNumberInput")).toEqual({
      verdict: "error",
      reason: "FillNumberInput",
    })
    expect(bulktextVerdictFor("failed", "bad-options")).toEqual({
      verdict: "error",
      reason: "bad-options",
    })
    expect(bulktextVerdictFor("failed", "x".repeat(300))?.reason).toHaveLength(
      120,
    )
    expect(bulktextVerdictFor("failed", "  ")).toBeNull()
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
        ["shortText:bt_failed_at", "f-failed-at"],
        ["shortText:bt_failed_inbox", "f-failed-inbox"],
        ["shortText:bt_failed_to", "f-failed-to"],
      ]),
      createdIds: [],
    })
  })

  test("skip: writes verdict + reason + failed-at by resolved field id, drops the other class tags, tags bt-blocked for EVERY failure", async () => {
    await expect(
      applyBulktextVerdict({
        ...base,
        status: "failed",
        error: "no-reply-streak",
        timestamp: "2026-09-21T22:00:00.000Z",
        failedTo: "+12155550199",
      }),
    ).resolves.toBe("skip")
    expect(mockResolve).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      fields: [
        { name: "bt_verdict", type: "shortText" },
        { name: "bt_reason", type: "shortText" },
        { name: "bt_failed_at", type: "shortText" },
        { name: "bt_failed_inbox", type: "shortText" },
        { name: "bt_failed_to", type: "shortText" },
      ],
    })
    expect(mockSetValue.mock.calls.map(([c]) => [c.keyword, c.value])).toEqual([
      ["f-verdict", "skip"],
      ["f-reason", "no-reply-streak"],
      ["f-failed-at", "2026-09-21T22:00:00.000Z"],
      ["f-failed-inbox", "inbox-1"],
      ["f-failed-to", "+12155550199"],
    ])
    expect(mockDetach).toHaveBeenCalledWith(
      expect.objectContaining({
        contactIds: ["c-1"],
        names: ["bt-unreachable", "bt-send-error"],
      }),
    )
    expect(mockAttach).toHaveBeenCalledWith(
      expect.objectContaining({
        contactIds: ["c-1"],
        names: ["bt-blocked"],
        contactInbox,
        emitFor: "all",
      }),
    )
    // Order: the stale classes come off BEFORE the new one goes on.
    expect(mockDetach.mock.invocationCallOrder[0]).toBeLessThan(
      mockAttach.mock.invocationCallOrder[0],
    )
  })

  test("unreachable (s172): a contact-data failure tags bt-unreachable, never bt-blocked; a bad timestamp falls back to now", async () => {
    const before = Date.now()
    await expect(
      applyBulktextVerdict({
        ...base,
        status: "failed",
        error: "bad-number",
        timestamp: "yesterday",
      }),
    ).resolves.toBe("unreachable")
    const values = mockSetValue.mock.calls.map(([c]) => [c.keyword, c.value])
    expect(values.slice(0, 2)).toEqual([
      ["f-verdict", "unreachable"],
      ["f-reason", "bad-number"],
    ])
    expect(values[2][0]).toBe("f-failed-at")
    expect(Date.parse(values[2][1] as string)).toBeGreaterThanOrEqual(before)
    expect(mockDetach).toHaveBeenCalledWith(
      expect.objectContaining({ names: ["bt-blocked", "bt-send-error"] }),
    )
    expect(mockAttach).toHaveBeenCalledWith(
      expect.objectContaining({ names: ["bt-unreachable"], emitFor: "all" }),
    )
  })

  test("error (s172): a line failure tags bt-send-error only", async () => {
    await expect(
      applyBulktextVerdict({ ...base, status: "failed", error: "line-error" }),
    ).resolves.toBe("error")
    expect(
      mockSetValue.mock.calls.map(([c]) => [c.keyword, c.value]).slice(0, 2),
    ).toEqual([
      ["f-verdict", "error"],
      ["f-reason", "line-error"],
    ])
    expect(mockDetach).toHaveBeenCalledWith(
      expect.objectContaining({ names: ["bt-blocked", "bt-unreachable"] }),
    )
    expect(mockAttach).toHaveBeenCalledWith(
      expect.objectContaining({ names: ["bt-send-error"], emitFor: "all" }),
    )
  })

  test("send: writes send + empty reason + empty failed-at and removes all three failure tags", async () => {
    await expect(
      applyBulktextVerdict({ ...base, status: "delivered", error: undefined }),
    ).resolves.toBe("send")
    expect(mockSetValue.mock.calls.map(([c]) => [c.keyword, c.value])).toEqual([
      ["f-verdict", "send"],
      ["f-reason", ""],
      ["f-failed-at", ""],
      ["f-failed-inbox", ""],
      ["f-failed-to", ""],
    ])
    expect(mockDetach).toHaveBeenCalledWith(
      expect.objectContaining({
        contactIds: ["c-1"],
        names: [
          "bt-blocked",
          "bt-unreachable",
          "bt-send-error",
          "bt-repair-asked",
        ],
      }),
    )
    expect(mockAttach).not.toHaveBeenCalled()
  })

  test("a failed status with no error text touches nothing; an unclassified text is a send-error", async () => {
    await expect(
      applyBulktextVerdict({ ...base, status: "failed", error: undefined }),
    ).resolves.toBeNull()
    expect(mockResolve).not.toHaveBeenCalled()
    expect(mockSetValue).not.toHaveBeenCalled()
    await expect(
      applyBulktextVerdict({ ...base, status: "failed", error: "media-fetch" }),
    ).resolves.toBe("error")
    expect(mockAttach).toHaveBeenCalledWith(
      expect.objectContaining({ names: ["bt-send-error"] }),
    )
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
