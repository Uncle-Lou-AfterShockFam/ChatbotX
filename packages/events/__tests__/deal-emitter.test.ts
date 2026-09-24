import { triggerEventTypes } from "@chatbotx.io/database/partials"
import { describe, expect, test, vi } from "vitest"
import { BaseEventEmitter, type DealEventMetadata } from "../src/base-emitter"
import {
  EMITTED_EVENT_TYPES,
  isMatchableEventType,
} from "../src/event-type-registry"

const DEAL: DealEventMetadata = {
  dealId: "deal-1",
  pipelineId: "pipe-1",
  stageId: "stage-2",
  title: "Roof",
  value: "100.00",
  currency: "USD",
  status: "open",
  priority: "medium",
  ownerId: null,
  companyId: "co-1",
}

class RecordingEmitter extends BaseEventEmitter {
  protected supportedEventTypes = new Set(EMITTED_EVENT_TYPES)
  queued = vi.fn<
    (
      eventType: string,
      data: { workspaceId: string; contactId: string; metadata?: unknown },
    ) => Promise<void>
  >(async () => undefined)
  protected shouldEmitEvent() {
    return Promise.resolve(true)
  }
  protected emitToQueue(
    eventType: string,
    data: { workspaceId: string; contactId: string; metadata?: unknown },
  ) {
    return this.queued(eventType, data)
  }
}

describe("deal events", () => {
  test("the five ticket* types are emitted and matchable", () => {
    for (const type of [
      "ticketCreated",
      "ticketMovedToStage",
      "ticketValueChanged",
      "ticketStatusChanged",
      "ticketPriorityChanged",
    ] as const) {
      expect(EMITTED_EVENT_TYPES).toContain(type)
      expect(isMatchableEventType(type)).toBe(true)
    }
  })

  test.each([
    ["dealCreated", "ticketCreated", DEAL, "pipe-1"],
    [
      "dealMovedToStage",
      "ticketMovedToStage",
      { ...DEAL, fromStageId: "stage-1" },
      "stage-2",
    ],
    [
      "dealValueChanged",
      "ticketValueChanged",
      { ...DEAL, oldValue: null },
      "pipe-1",
    ],
    [
      "dealStatusChanged",
      "ticketStatusChanged",
      { ...DEAL, oldStatus: "open" },
      "pipe-1",
    ],
    [
      "dealPriorityChanged",
      "ticketPriorityChanged",
      { ...DEAL, oldPriority: "low" },
      "pipe-1",
    ],
  ] as const)("%s emits %s with sourceId %s", async (method, type, meta, sourceId) => {
    const emitter = new RecordingEmitter()
    await (
      emitter[method] as (w: string, c: string, m: typeof meta) => Promise<void>
    )("ws-1", "contact-1", meta)
    expect(emitter.queued).toHaveBeenCalledTimes(1)
    const [queuedType, data] = emitter.queued.mock.calls[0] as [
      string,
      { metadata: Record<string, unknown> },
    ]
    expect(queuedType).toBe(triggerEventTypes.enum[type])
    expect(data.metadata.sourceId).toBe(sourceId)
    expect(data.metadata.dealId).toBe("deal-1")
  })

  test("a deal event without a contact is dropped before the queue", async () => {
    const emitter = new RecordingEmitter()
    await emitter.dealCreated("ws-1", "", DEAL)
    expect(emitter.queued).not.toHaveBeenCalled()
  })
})
