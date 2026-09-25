import { afterEach, describe, expect, test, vi } from "vitest"
import {
  computeTriggerAt,
  delayTypeEventDefaultFn,
  stateTypes,
  stepTypes,
  waitForEventSpecFromStep,
  waitForEventSpecSchema,
  waitStepDelayTypes,
  waitStepDelayUnits,
  waitStepEventTypes,
  waitStepSchema,
} from "../src"

const base = { id: "1", stepType: stepTypes.enum.wait }

const eventStep = (extra: Record<string, unknown> = {}) => ({
  ...base,
  delayType: waitStepDelayTypes.enum.event,
  ...delayTypeEventDefaultFn(),
  tagId: "tag-1",
  ...extra,
})

describe("wait step: event delay type", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  test("defaults every field but the states so an old saved graph still parses", () => {
    const parsed = waitStepSchema.safeParse({
      ...base,
      delayType: "event",
      tagId: "tag-1",
      states: delayTypeEventDefaultFn().states,
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success || parsed.data.delayType !== "event") {
      throw new Error("unreachable")
    }
    expect(parsed.data.eventType).toBe(waitStepEventTypes.enum.tagApplied)
    expect(parsed.data.timeoutValue).toBe(1)
    expect(parsed.data.timeoutUnit).toBe(waitStepDelayUnits.enum.days)
    expect(parsed.data.states.map((s) => s.stateType)).toEqual([
      stateTypes.success,
      stateTypes.skip,
    ])
  })

  test("the states are REQUIRED (no schema default): the node defaultFn mints them", () => {
    // A schema default calling createId() made the OpenAPI document (and its
    // ETag) differ on every generation; the ids belong to node creation.
    const parsed = waitStepSchema.safeParse({
      ...base,
      delayType: "event",
      tagId: "tag-1",
    })
    expect(parsed.success).toBe(false)
    expect(delayTypeEventDefaultFn().states.map((s) => s.stateType)).toEqual([
      stateTypes.success,
      stateTypes.skip,
    ])
  })

  test("refuses a tag wait without a tag and a field wait without a field", () => {
    expect(waitStepSchema.safeParse(eventStep({ tagId: "" })).success).toBe(
      false,
    )
    expect(
      waitStepSchema.safeParse(
        eventStep({
          eventType: waitStepEventTypes.enum.customFieldChanged,
          customFieldId: "",
        }),
      ).success,
    ).toBe(false)
    expect(
      waitStepSchema.safeParse(
        eventStep({
          eventType: waitStepEventTypes.enum.customFieldChanged,
          customFieldId: "cf-1",
        }),
      ).success,
    ).toBe(true)
  })

  test("refuses an unknown event type and a zero timeout", () => {
    expect(
      waitStepSchema.safeParse(eventStep({ eventType: "emailOpened" })).success,
    ).toBe(false)
    expect(
      waitStepSchema.safeParse(eventStep({ timeoutValue: 0 })).success,
    ).toBe(false)
  })

  test("the trigger instant is the timeout", async () => {
    // Build the step BEFORE freezing the clock: createId() is a snowflake and
    // refuses a clock that moved backwards.
    const step = waitStepSchema.parse(
      eventStep({
        timeoutValue: 2,
        timeoutUnit: waitStepDelayUnits.enum.minutes,
      }),
    )
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-09-23T18:00:00.000Z"))
    expect(await computeTriggerAt(step)).toEqual(
      new Date("2026-09-23T18:02:00.000Z"),
    )
  })

  test("the stored spec carries only the key its event type needs", () => {
    expect(waitForEventSpecFromStep(waitStepSchema.parse(eventStep()))).toEqual(
      {
        eventType: "tagApplied",
        tagId: "tag-1",
      },
    )
    expect(
      waitForEventSpecFromStep(
        waitStepSchema.parse(
          eventStep({
            eventType: waitStepEventTypes.enum.customFieldChanged,
            customFieldId: "cf-1",
          }),
        ),
      ),
    ).toEqual({ eventType: "customFieldChanged", customFieldId: "cf-1" })
    expect(
      waitForEventSpecFromStep(
        waitStepSchema.parse({
          ...base,
          delayType: "duration",
          duration: 1,
          unit: "hours",
          interval: false,
          startTime: null,
          endTime: null,
        }),
      ),
    ).toBeNull()
    expect(waitForEventSpecSchema.safeParse({ eventType: "x" }).success).toBe(
      false,
    )
  })
})

describe("wait step: event matchValue", () => {
  const fieldStep = (extra: Record<string, unknown> = {}) => ({
    ...base,
    delayType: waitStepDelayTypes.enum.event,
    ...delayTypeEventDefaultFn(),
    eventType: waitStepEventTypes.enum.customFieldChanged,
    customFieldId: "cf-1",
    ...extra,
  })

  test("defaults to empty (any change) and parses an old graph without the key", () => {
    const parsed = waitStepSchema.parse({
      ...base,
      delayType: "event",
      eventType: "customFieldChanged",
      customFieldId: "cf-1",
      states: delayTypeEventDefaultFn().states,
    })
    if (parsed.delayType !== "event") {
      throw new Error("unreachable")
    }
    expect(parsed.matchValue).toBe("")
    expect(waitForEventSpecFromStep(parsed)).toEqual({
      eventType: "customFieldChanged",
      customFieldId: "cf-1",
    })
  })

  test("a tag wait cannot carry a matchValue; over-long values are refused", () => {
    expect(
      waitStepSchema.safeParse(eventStep({ matchValue: "3635" })).success,
    ).toBe(false)
    expect(
      waitStepSchema.safeParse(fieldStep({ matchValue: "x".repeat(501) }))
        .success,
    ).toBe(false)
  })

  test("the stored spec keeps the RESOLVED value, trimmed input, capped", () => {
    const parsed = waitStepSchema.parse(
      fieldStep({ matchValue: "  {{raw:wp_order_id}} " }),
    )
    expect(waitForEventSpecFromStep(parsed, "3635")).toEqual({
      eventType: "customFieldChanged",
      customFieldId: "cf-1",
      matchValue: "3635",
    })
    // No resolved value handed in: the (literal) step value is stored.
    expect(waitForEventSpecFromStep(parsed)?.matchValue).toBe(
      "{{raw:wp_order_id}}",
    )
    // The caller's fail-closed "" is kept, never replaced by the template.
    expect(waitForEventSpecFromStep(parsed, "")?.matchValue).toBe("")
    expect(
      waitForEventSpecFromStep(parsed, "9".repeat(900))?.matchValue,
    ).toHaveLength(500)
    expect(
      waitForEventSpecSchema.safeParse(waitForEventSpecFromStep(parsed, "3635"))
        .success,
    ).toBe(true)
  })

  test("the stored spec schema trims, like the step and the resume compare", () => {
    expect(
      waitForEventSpecSchema.parse({
        eventType: "customFieldChanged",
        customFieldId: "cf-1",
        matchValue: " 3635 ",
      }).matchValue,
    ).toBe("3635")
  })
})
