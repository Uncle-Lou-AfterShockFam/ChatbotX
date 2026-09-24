import { triggerEventTypes } from "@chatbotx.io/database/partials"
import { beforeEach, describe, expect, test, vi } from "vitest"

// ---------------------------------------------------------------------------
// Webhook payload regression (§5.8, finding 5): contactInboxId reaches the
// webhook queue's shared eventData bag (same metadata BaseEventEmitter feeds
// both trigger and webhook queues), but the outbound webhook payload must
// NEVER surface it — it is an internal attribution detail, not a documented
// public field. Every builder in webhook-payload.builder.ts EXCEPT
// dateTimeBasedTrigger's selectively projects named fields, so seeding
// eventData with contactInboxId and asserting it never appears in the built
// payload is a true regression guard for those event types.
//
// dateTimeBasedTrigger is a DOCUMENTED EXCEPTION, not covered by the same
// guarantee: its builder is `(basePayload, data) => ({ ...basePayload,
// ...data })` — a full spread — so IF eventData ever carried a
// contactInboxId it WOULD leak into the payload. This is safe today only
// because the sole real producer (datetime-webhook-evaluator.ts's
// enqueueWebhookEvaluation) builds eventData as `{ sourceId }` literal and
// never threads a contactInboxId (schema-precludes-attribution — Conversation
// has no inbox column). The two tests below document both halves of that
// contract: the real-world shape never leaks, and the spread would leak IF
// misused, which is the reason no producer is ever allowed to seed it.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  contactFindById: vi.fn(),
  listWithDefinitions: vi.fn(),
  findNameByIdForWorkspace: vi.fn(),
}))

vi.mock("@chatbotx.io/business", () => ({
  contactCustomFieldService: { listWithDefinitions: mocks.listWithDefinitions },
  contactService: { findById: mocks.contactFindById },
  tagService: {
    findNameByIdForWorkspace: (...args: unknown[]) =>
      mocks.findNameByIdForWorkspace(...args),
  },
}))

const { buildWebhookPayload } = await import(
  "../src/webhook/services/webhook-payload.builder"
)

const LEAK_SENTINEL = "ci-should-never-leak"
const timestamp = new Date("2026-08-27T00:00:00.000Z")

// Minimal, per-event-type eventData that satisfies each builder's real field
// reads, WITH a contactInboxId injected — exactly what the shared metadata
// bag looks like once a producer threads one (§3.1/§3.5/§3.6).
const DEAL_EVENT_DATA = {
  dealId: "deal-1",
  pipelineId: "pipe-1",
  stageId: "stage-1",
  sourceId: "pipe-1",
  title: "Roof",
  value: "100.00",
  currency: "USD",
  status: "open",
  priority: "medium",
  ownerId: null,
  companyId: null,
}

const DEAL_TASK_EVENT_DATA = {
  ...DEAL_EVENT_DATA,
  taskId: "task-1",
  taskTitle: "Call back",
  taskDueAt: null,
  assigneeId: null,
  templateId: null,
}

const EVENT_DATA_BY_TYPE: Record<string, Record<string, unknown>> = {
  [triggerEventTypes.enum.tagApplied]: { tagId: "tag-1" },
  [triggerEventTypes.enum.tagRemoved]: { tagId: "tag-1" },
  [triggerEventTypes.enum.customFieldValueChanged]: {
    customFieldName: "Plan",
    oldValue: "free",
    newValue: "pro",
  },
  [triggerEventTypes.enum.contactInfoUpdated]: {
    infoType: "email",
    oldValue: "old@example.com",
    newValue: "new@example.com",
  },
  [triggerEventTypes.enum.conversationTransferredToHuman]: {
    conversationId: "conv-1",
    transferredBy: "user-1",
  },
  [triggerEventTypes.enum.conversationTransferredToBot]: {
    conversationId: "conv-1",
    transferredBy: "user-1",
  },
  [triggerEventTypes.enum.newContact]: {
    name: "Ada",
    phone: "+15551234567",
    email: "ada@example.com",
  },
  [triggerEventTypes.enum.contactUnsubscribedFormBroadcast]: {},
  [triggerEventTypes.enum.archived]: {
    conversationId: "conv-1",
    archivedBy: "user-1",
  },
  [triggerEventTypes.enum.followUp]: {
    conversationId: "conv-1",
    markedBy: "user-1",
  },
  [triggerEventTypes.enum.conversationAssigned]: {
    conversationId: "conv-1",
    assignedTo: "user-1",
    assignedBy: "user-2",
  },
  [triggerEventTypes.enum.conversationUnassigned]: {
    conversationId: "conv-1",
    unassignedBy: "user-1",
  },
  [triggerEventTypes.enum.subscribedToSequence]: {
    sequenceId: "seq-1",
    sequenceName: "Welcome",
  },
  [triggerEventTypes.enum.unsubscribedFromSequence]: {
    sequenceId: "seq-1",
    sequenceName: "Welcome",
  },
  [triggerEventTypes.enum.contactReferredANewContact]: {
    refName: "summer",
    reflinkId: "reflink-1",
  },
  [triggerEventTypes.enum.contactReferredExistingContact]: {
    refName: "summer",
    reflinkId: "reflink-1",
  },
  [triggerEventTypes.enum.ticketCreated]: DEAL_EVENT_DATA,
  [triggerEventTypes.enum.ticketMovedToStage]: {
    ...DEAL_EVENT_DATA,
    fromStageId: "stage-0",
  },
  [triggerEventTypes.enum.ticketValueChanged]: {
    ...DEAL_EVENT_DATA,
    oldValue: "50.00",
  },
  [triggerEventTypes.enum.ticketStatusChanged]: {
    ...DEAL_EVENT_DATA,
    oldStatus: "open",
  },
  [triggerEventTypes.enum.ticketPriorityChanged]: {
    ...DEAL_EVENT_DATA,
    oldPriority: "low",
  },
  [triggerEventTypes.enum.taskCreated]: DEAL_TASK_EVENT_DATA,
  [triggerEventTypes.enum.taskCompleted]: {
    ...DEAL_TASK_EVENT_DATA,
    completedById: "user-1",
  },
  [triggerEventTypes.enum.taskOverdue]: DEAL_TASK_EVENT_DATA,
  [triggerEventTypes.enum.taskAssigned]: {
    ...DEAL_TASK_EVENT_DATA,
    previousAssigneeId: null,
  },
}

// Every MatchableEventType EXCEPT dateTimeBasedTrigger (documented exception
// above) — the EMITTED_EVENT_TYPES from event-type-registry.ts (30 as of the deal task events).
const SELECTIVELY_PROJECTED_EVENT_TYPES = Object.keys(EVENT_DATA_BY_TYPE)

describe("buildWebhookPayload — contactInboxId never leaks (selectively-projecting builders)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.findNameByIdForWorkspace.mockResolvedValue("VIP")
    mocks.contactFindById.mockResolvedValue({
      id: "contact-1",
      fullName: "Ada Lovelace",
      firstName: "Ada",
      lastName: "Lovelace",
      phoneNumber: "+15551234567",
      email: "ada@example.com",
    })
    mocks.listWithDefinitions.mockResolvedValue([])
  })

  test.each(
    SELECTIVELY_PROJECTED_EVENT_TYPES,
  )("%s: contactInboxId seeded in eventData never appears in the built payload", async (eventType) => {
    const payload = await buildWebhookPayload({
      eventType: eventType as never,
      contactId: "contact-1",
      workspaceId: "workspace-1",
      timestamp,
      eventData: {
        ...EVENT_DATA_BY_TYPE[eventType],
        contactInboxId: LEAK_SENTINEL,
      },
    } as never)

    expect(payload).not.toHaveProperty("contactInboxId")
    expect(JSON.stringify(payload)).not.toContain(LEAK_SENTINEL)
  })
})

describe("buildWebhookPayload — dateTimeBasedTrigger (documented spread exception)", () => {
  test("real-world eventData shape (sourceId only) never contains contactInboxId — matches datetime-webhook-evaluator.ts's literal", async () => {
    const payload = await buildWebhookPayload({
      eventType: triggerEventTypes.enum.dateTimeBasedTrigger,
      contactId: "contact-1",
      workspaceId: "workspace-1",
      timestamp,
      eventData: { sourceId: "custom-field-1" },
    } as never)

    expect(payload).not.toHaveProperty("contactInboxId")
  })

  test("documents that the ...data spread WOULD leak an artificially-seeded contactInboxId — this is exactly why no producer is ever allowed to thread one for this event type", async () => {
    const payload = await buildWebhookPayload({
      eventType: triggerEventTypes.enum.dateTimeBasedTrigger,
      contactId: "contact-1",
      workspaceId: "workspace-1",
      timestamp,
      eventData: { sourceId: "custom-field-1", contactInboxId: LEAK_SENTINEL },
    } as never)

    expect(payload).toHaveProperty("contactInboxId", LEAK_SENTINEL)
  })
})
