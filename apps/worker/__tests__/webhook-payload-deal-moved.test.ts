import { triggerEventTypes } from "@chatbotx.io/database/partials"
import { beforeEach, describe, expect, test, vi } from "vitest"

// s196: a deal moved across pipelines names the pipeline it LEFT in the
// ticketMovedToStage webhook; a plain stage move reports its own pipeline.

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

const DEAL = {
  dealId: "deal-1",
  pipelineId: "pipe-2",
  stageId: "stage-9",
  sourceId: "stage-9",
  title: "Roof",
  value: "100.00",
  currency: "USD",
  status: "open",
  priority: "medium",
  fromStageId: "stage-1",
}

const build = (eventData: Record<string, unknown>) =>
  buildWebhookPayload({
    eventType: triggerEventTypes.enum.ticketMovedToStage,
    contactId: "contact-1",
    workspaceId: "workspace-1",
    timestamp: new Date("2026-09-25T00:00:00.000Z"),
    eventData,
  } as never) as Promise<Record<string, unknown>>

describe("ticketMovedToStage webhook: from_pipeline_id", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.contactFindById.mockResolvedValue({ id: "contact-1" })
    mocks.listWithDefinitions.mockResolvedValue([])
  })

  test("a cross-pipeline move names the pipeline it left", async () => {
    const payload = await build({ ...DEAL, fromPipelineId: "pipe-1" })
    expect(payload.from_pipeline_id).toBe("pipe-1")
    expect(payload.from_stage_id).toBe("stage-1")
  })

  test("a stage move inside one pipeline reports that pipeline", async () => {
    const payload = await build(DEAL)
    expect(payload.from_pipeline_id).toBe("pipe-2")
  })
})
