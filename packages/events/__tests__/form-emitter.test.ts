import { triggerEventTypes } from "@chatbotx.io/database/partials"
import { describe, expect, test, vi } from "vitest"
import {
  BaseEventEmitter,
  type FormSubmittedMetadata,
} from "../src/base-emitter"
import {
  EMITTED_EVENT_TYPES,
  isMatchableEventType,
} from "../src/event-type-registry"

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

const META: FormSubmittedMetadata = {
  formId: "form-1",
  formSlug: "demo-intake",
  submissionId: "sub-1",
  definitionVersion: 1,
  values: { first_name: "Ada", interest: "other", tags: ["a"] },
}

describe("formSubmitted (s200)", () => {
  test("is emitted, matchable, and pinned to the form as sourceId", async () => {
    expect(EMITTED_EVENT_TYPES).toContain("formSubmitted")
    expect(isMatchableEventType("formSubmitted")).toBe(true)
    const emitter = new RecordingEmitter()
    await emitter.formSubmitted("ws-1", "contact-1", META)
    expect(emitter.queued).toHaveBeenCalledWith(
      triggerEventTypes.enum.formSubmitted,
      {
        workspaceId: "ws-1",
        contactId: "contact-1",
        metadata: { ...META, sourceId: "form-1" },
      },
    )
  })

  test("a contactless emit is dropped, never queued (triggers are contact-scoped)", async () => {
    const emitter = new RecordingEmitter()
    await emitter.formSubmitted("ws-1", "", META)
    expect(emitter.queued).not.toHaveBeenCalled()
  })
})
