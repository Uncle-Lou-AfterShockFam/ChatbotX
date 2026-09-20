import { beforeEach, describe, expect, test, vi } from "vitest"

const { mockPostSignedEnvelope } = vi.hoisted(() => ({
  mockPostSignedEnvelope: vi.fn(),
}))

vi.mock("../src/lib/delivery", () => ({
  postSignedEnvelope: mockPostSignedEnvelope,
}))

const { sendFlowStep } = await import(
  "../src/handlers/message/outgoing-message"
)

const ctx = {
  auth: {
    callbackUrl: "https://example.com/callback",
    signingSecret: "secret",
  },
} as never

const contact = { id: "contact-1", sourceId: "source-1" } as never

describe("api sendFlowStep — sendMultipleImages", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPostSignedEnvelope.mockResolvedValue({ messageId: "m_1" })
  })

  test("maps every image into contentAttributes.attachments instead of degrading to text", async () => {
    const result = await sendFlowStep({
      ctx,
      data: {
        contact,
        quickReplies: [],
        step: {
          id: "step-1",
          nodeId: "node-1",
          stepType: "sendMultipleImages",
          images: [
            { id: "img-1", mode: "url", url: "https://example.com/a.png" },
            { id: "img-2", mode: "url", url: "https://example.com/b.png" },
            { id: "img-3", mode: "url", url: "https://example.com/c.png" },
          ],
        },
      },
    } as never)

    expect(mockPostSignedEnvelope).toHaveBeenCalledTimes(1)
    const [{ envelope }] = mockPostSignedEnvelope.mock.calls[0]
    expect(envelope.message.text).toBeNull()
    expect(envelope.message.contentAttributes).toEqual({
      attachments: [
        { url: "https://example.com/a.png", fileType: "image" },
        { url: "https://example.com/b.png", fileType: "image" },
        { url: "https://example.com/c.png", fileType: "image" },
      ],
    })
    expect(result).toEqual({ messageIds: ["m_1"] })
  })
})

describe("api sendFlowStep — bulktextSend", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPostSignedEnvelope.mockResolvedValue({ messageId: "msg:57" })
  })

  test("carries the text, a photo attachment and the delivery options under contentAttributes.bulktext", async () => {
    const result = await sendFlowStep({
      ctx,
      data: {
        contact,
        quickReplies: [],
        step: {
          id: "step-1",
          nodeId: "node-1",
          stepType: "bulktextSend",
          text: "Hi Lou",
          photoUrl: "https://example.com/a.jpg",
          ref: "camp:1",
          dryRun: false,
          scheduleAt: "",
          spreadOverMinutes: 30,
          skipIfRepliedSince: "2026-09-20T00:00:00Z",
        },
      },
    } as never)

    const [{ envelope }] = mockPostSignedEnvelope.mock.calls[0]
    expect(envelope.message.text).toBe("Hi Lou")
    expect(envelope.message.contentAttributes).toEqual({
      attachments: [{ url: "https://example.com/a.jpg", fileType: "image" }],
      bulktext: {
        dryRun: false,
        ref: "camp:1",
        spreadOverMinutes: 30,
        skipIfRepliedSince: "2026-09-20T00:00:00Z",
      },
    })
    expect(result).toEqual({ messageIds: ["msg:57"] })
  })

  test("photo-only: null text, no empty option keys", async () => {
    await sendFlowStep({
      ctx,
      data: {
        contact,
        quickReplies: [],
        step: {
          id: "step-1",
          nodeId: "node-1",
          stepType: "bulktextSend",
          text: "",
          photoUrl: "https://example.com/a.jpg",
          ref: "",
          dryRun: true,
          scheduleAt: "",
          spreadOverMinutes: 0,
          skipIfRepliedSince: "",
        },
      },
    } as never)
    const [{ envelope }] = mockPostSignedEnvelope.mock.calls[0]
    expect(envelope.message.text).toBeNull()
    expect(envelope.message.contentAttributes).toEqual({
      attachments: [{ url: "https://example.com/a.jpg", fileType: "image" }],
      bulktext: { dryRun: true },
    })
  })
})
