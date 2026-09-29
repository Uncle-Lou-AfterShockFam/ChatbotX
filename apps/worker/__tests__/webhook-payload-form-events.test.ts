import { triggerEventTypes } from "@chatbotx.io/database/partials"
import { beforeEach, describe, expect, test, vi } from "vitest"

// s220 A2-3: form_submitted carries the channel / conversation / score the
// chat run added; form_abandoned says where the contact stopped, never answers.

const mocks = vi.hoisted(() => ({
  contactFindById: vi.fn(),
  listWithDefinitions: vi.fn(),
  findNameByIdForWorkspace: vi.fn(),
}))

vi.mock("@chatbotx.io/business", () => ({
  contactCustomFieldService: { listWithDefinitions: mocks.listWithDefinitions },
  contactService: { findById: mocks.contactFindById },
  tagService: { findNameByIdForWorkspace: mocks.findNameByIdForWorkspace },
}))

const { buildWebhookPayload } = await import(
  "../src/webhook/services/webhook-payload.builder"
)

const build = (eventType: string, eventData: Record<string, unknown>) =>
  buildWebhookPayload({
    eventType,
    contactId: "contact-1",
    workspaceId: "workspace-1",
    timestamp: new Date("2026-09-29T00:00:00.000Z"),
    eventData,
  } as never) as Promise<Record<string, unknown>>

beforeEach(() => {
  vi.clearAllMocks()
  mocks.contactFindById.mockResolvedValue({ id: "contact-1" })
  mocks.listWithDefinitions.mockResolvedValue([])
})

describe("form webhooks", () => {
  test("form_submitted from a chat run names the channel, conversation and score", async () => {
    const payload = await build(triggerEventTypes.enum.formSubmitted, {
      formId: "form-1",
      formSlug: "intake",
      submissionId: "sub-1",
      definitionVersion: 2,
      values: { email: "a@example.com" },
      channel: "chat",
      conversationId: "conv-1",
      score: 7,
    })
    expect(payload.event).toBe("form_submitted")
    expect(payload.form).toEqual({
      id: "form-1",
      slug: "intake",
      submission_id: "sub-1",
      version: 2,
      values: { email: "a@example.com" },
      channel: "chat",
      conversation_id: "conv-1",
      score: 7,
    })
  })

  test("an older form_submitted (no channel) reads as web, unscored", async () => {
    const payload = await build(triggerEventTypes.enum.formSubmitted, {
      formId: "form-1",
      formSlug: "intake",
      submissionId: "sub-1",
      definitionVersion: 1,
      values: "not-a-record",
    })
    expect(payload.form).toMatchObject({
      channel: "web",
      conversation_id: null,
      score: null,
      values: {},
    })
  })

  test("form_abandoned says where the run stopped", async () => {
    const payload = await build(triggerEventTypes.enum.formAbandoned, {
      formId: "form-1",
      formSessionId: "fs-1",
      channel: "chat",
      reason: "attempts",
      lastFieldKey: "email",
      askedCount: 3,
      conversationId: "conv-1",
      flowId: "flow-1",
    })
    expect(payload.event).toBe("form_abandoned")
    expect(payload.form).toEqual({
      id: "form-1",
      session_id: "fs-1",
      channel: "chat",
      reason: "attempts",
      last_field_key: "email",
      asked_count: 3,
      conversation_id: "conv-1",
    })
  })

  test("form_abandoned with an unknown reason and no field reads as a timeout", async () => {
    const payload = await build(triggerEventTypes.enum.formAbandoned, {
      formId: "form-1",
      formSessionId: "fs-1",
      reason: "bogus",
      conversationId: "conv-1",
    })
    expect(payload.form).toMatchObject({
      reason: "timeout",
      last_field_key: null,
      asked_count: 0,
    })
  })
})
