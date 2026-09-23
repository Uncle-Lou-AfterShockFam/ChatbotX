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

  test("defaults every field so an old saved graph still parses", () => {
    const parsed = waitStepSchema.safeParse({
      ...base,
      delayType: "event",
      tagId: "tag-1",
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
