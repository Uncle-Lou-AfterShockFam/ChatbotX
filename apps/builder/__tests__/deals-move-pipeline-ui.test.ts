import { describe, expect, test } from "vitest"
import { describeActivity } from "@/features/deals/deal-drawer/activity-list"
import {
  buildMovePipelineInput,
  fieldsNeedingInput,
  movePipelineOwnerOptions,
} from "@/features/deals/lib/move-pipeline"
import { namesById } from "@/features/deals/lib/names-by-id"
import type { DealActivityResource } from "@/features/deals/schema/resource"

// s196: the move-to-pipeline dialog's pure helpers + the activity line.

const t = ((key: string, values?: Record<string, unknown>) =>
  values ? `${key}|${JSON.stringify(values)}` : key) as unknown as Parameters<
  typeof describeActivity
>[2]

const DEFS = [
  { key: "sqft", label: "Sq ft", type: "number" as const, required: true },
  {
    key: "roof",
    label: "Roof",
    type: "select" as const,
    options: ["metal", "shingle"],
    required: false,
  },
  { key: "notes", label: "Notes", type: "longText" as const, required: false },
]

describe("fieldsNeedingInput", () => {
  test("a required key that is missing or null needs input", () => {
    expect(fieldsNeedingInput(DEFS, {}).map((d) => d.key)).toEqual(["sqft"])
    expect(fieldsNeedingInput(DEFS, { sqft: null }).map((d) => d.key)).toEqual([
      "sqft",
    ])
  })

  test("a stored value of the wrong type for the destination needs input, an optional absent one does not", () => {
    expect(
      fieldsNeedingInput(DEFS, { sqft: 10, roof: "tile" }).map((d) => d.key),
    ).toEqual(["roof"])
    expect(fieldsNeedingInput(DEFS, { sqft: 10 })).toEqual([])
  })

  test("no destination defs = nothing to ask; undeclared keys ride along", () => {
    expect(fieldsNeedingInput([], { anything: [1, 2] })).toEqual([])
  })
})

describe("movePipelineOwnerOptions", () => {
  const OWNERS = [
    { label: "Ann", value: "u1" },
    { label: "Bob", value: "u2" },
    { label: "Cy", value: "u3" },
  ]
  test("a workspace pipeline offers every member", () => {
    expect(
      movePipelineOwnerOptions({
        access: "workspace",
        memberIds: [],
        ownerOptions: OWNERS,
        currentOwnerId: "u1",
      }),
    ).toEqual(OWNERS)
  })
  test("a members-only pipeline offers its members plus today's owner", () => {
    expect(
      movePipelineOwnerOptions({
        access: "members",
        memberIds: ["u2"],
        ownerOptions: OWNERS,
        currentOwnerId: "u3",
      }).map((o) => o.value),
    ).toEqual(["u2", "u3"])
    expect(
      movePipelineOwnerOptions({
        access: "members",
        memberIds: [],
        ownerOptions: OWNERS,
        currentOwnerId: null,
      }),
    ).toEqual([])
  })
})

describe("buildMovePipelineInput", () => {
  const base = {
    id: "d1",
    pipelineId: "p2",
    stageId: "",
    ownerId: "u1",
    currentOwnerId: "u1",
    fields: {},
  }
  test("an unchanged owner and no fields are left out; no stage = null (first stage)", () => {
    expect(buildMovePipelineInput(base)).toEqual({
      id: "d1",
      pipelineId: "p2",
      stageId: null,
    })
  })
  test("a new owner, a cleared owner and collected fields are sent", () => {
    expect(
      buildMovePipelineInput({
        ...base,
        stageId: "s9",
        ownerId: "u2",
        fields: { sqft: 5 },
      }),
    ).toEqual({
      id: "d1",
      pipelineId: "p2",
      stageId: "s9",
      ownerId: "u2",
      fields: { sqft: 5 },
    })
    expect(buildMovePipelineInput({ ...base, ownerId: "" }).ownerId).toBeNull()
  })
  test("no owner before and none picked = keep (nothing sent)", () => {
    expect(
      buildMovePipelineInput({ ...base, ownerId: "", currentOwnerId: null }),
    ).not.toHaveProperty("ownerId")
  })
})

describe("pipelineMoved activity line", () => {
  const names = namesById([
    { id: "p1", name: "Sales", stages: [{ id: "s1", name: "New" }] },
    { id: "p2", name: "Onboarding", stages: [{ id: "s9", name: "Kickoff" }] },
  ])
  const row = (payload: Record<string, unknown>) =>
    ({
      id: "a1",
      dealId: "d1",
      actorId: null,
      type: "pipelineMoved",
      payload,
      createdAt: new Date(),
      updatedAt: new Date(),
    }) as DealActivityResource

  test("names both pipelines and the landing stage", () => {
    expect(
      describeActivity(
        row({ fromPipelineId: "p1", toPipelineId: "p2", from: "s1", to: "s9" }),
        names,
        t,
      ),
    ).toBe(
      'deals.activity.pipelineMoved|{"fromPipeline":"Sales","toPipeline":"Onboarding","to":"Kickoff"}',
    )
  })

  test("a deleted pipeline falls back to its id; an empty payload never throws", () => {
    expect(
      describeActivity(
        row({ fromPipelineId: "gone", toPipelineId: "p2", to: "s9" }),
        names,
        t,
      ),
    ).toContain('"fromPipeline":"gone"')
    expect(describeActivity(row({}), names, t)).toBe(
      'deals.activity.pipelineMoved|{"fromPipeline":"","toPipeline":"","to":""}',
    )
  })
})
