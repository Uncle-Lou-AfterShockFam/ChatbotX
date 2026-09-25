import { createId, zodBigintAsString } from "@chatbotx.io/utils"
import {
  addDays,
  addMilliseconds,
  isValid,
  setHours,
  setMilliseconds,
  setMinutes,
  setSeconds,
} from "date-fns"
import { z } from "zod"
import {
  type SkipStateSchema,
  type SuccessStateSchema,
  skipStateDefaultFn,
  skipStateSchema,
  successStateDefaultFn,
  successStateSchema,
} from "../states"
import { stepTypes } from "./step-action"

export const waitStepDelayTypes = z.enum([
  "duration",
  "date",
  "random",
  "event",
])

/** `event`: park the run until this lands on the contact, or the timeout fires. */
export const waitStepEventTypes = z.enum(["tagApplied", "customFieldChanged"])

export const MATCH_VALUE_MAX = 500

/** What a parked `waitForEvent` row waits for (stored as ContactOnSmartDelay.eventSpec). */
export const waitForEventSpecSchema = z.object({
  eventType: waitStepEventTypes,
  tagId: z.string().trim().min(1).optional(),
  customFieldId: z.string().trim().min(1).optional(),
  // customFieldChanged only: the RESOLVED value the field must change TO,
  // captured once at wait start (so paying order B cannot resume invoice A).
  matchValue: z.string().max(MATCH_VALUE_MAX).optional(),
})
export type WaitForEventSpec = z.infer<typeof waitForEventSpecSchema>

export const waitStepDelayUnits = z.enum([
  "seconds",
  "minutes",
  "hours",
  "days",
])
export type WaitStepDelayUnit = z.infer<typeof waitStepDelayUnits>

export const waitStepDateTypes = z.enum(["specific", "dynamic"])

export const waitStepOffsetOperators = z.enum(["add", "subtract"])

const MAX_DELAY = 999_999

export const ENQUEUE_DELAY_MS = 5 * 60 * 1000

const UNIT_MS: Record<WaitStepDelayUnit, number> = {
  [waitStepDelayUnits.enum.seconds]: 1000,
  [waitStepDelayUnits.enum.minutes]: 60_000,
  [waitStepDelayUnits.enum.hours]: 3_600_000,
  [waitStepDelayUnits.enum.days]: 86_400_000,
}

export const delayUnitToMs = (unit: WaitStepDelayUnit): number => UNIT_MS[unit]

export const waitStepSchema = z
  .object({
    id: zodBigintAsString(),
    stepType: z.literal(stepTypes.enum.wait),
  })
  .and(
    z.discriminatedUnion("delayType", [
      z.object({
        delayType: z.literal(waitStepDelayTypes.enum.duration),
        duration: z.coerce.number().int().min(1).max(MAX_DELAY),
        unit: waitStepDelayUnits,
        interval: z.boolean(),
        startTime: z.iso.time().nullable(),
        endTime: z.iso.time().nullable(),
      }),
      z.object({
        delayType: z.literal(waitStepDelayTypes.enum.date),
        dateType: waitStepDateTypes,
        datetime: z.iso.datetime().optional(),
        outputFieldId: z.string().trim().min(1).optional(),
        offset: z.boolean().default(false),
        offsetOperator: waitStepOffsetOperators.optional(),
        offsetValue: z.coerce.number().int().min(1).max(MAX_DELAY).optional(),
        offsetUnit: waitStepDelayUnits.optional(),
      }),
      z.object({
        delayType: z.literal(waitStepDelayTypes.enum.random),
        min: z.coerce.number().int().min(1).max(MAX_DELAY),
        max: z.coerce.number().int().min(1).max(MAX_DELAY),
        unit: waitStepDelayUnits,
      }),
      // Every field defaults: a required field without one 422s every saved graph (fork PR #6).
      z.object({
        delayType: z.literal(waitStepDelayTypes.enum.event),
        eventType: waitStepEventTypes.default(
          waitStepEventTypes.enum.tagApplied,
        ),
        tagId: z.string().trim().optional().default(""),
        customFieldId: z.string().trim().optional().default(""),
        // customFieldChanged only; may hold {{variables}}, resolved at wait start. "" = any change.
        matchValue: z
          .string()
          .trim()
          .max(MATCH_VALUE_MAX)
          .optional()
          .default(""),
        timeoutValue: z.coerce.number().int().min(1).max(MAX_DELAY).default(1),
        timeoutUnit: waitStepDelayUnits.default(waitStepDelayUnits.enum.days),
        // success = the event landed, skip = timed out
        states: z
          .tuple([successStateSchema, skipStateSchema])
          .default(
            () =>
              [successStateDefaultFn(), skipStateDefaultFn()] as [
                SuccessStateSchema,
                SkipStateSchema,
              ],
          ),
      }),
    ]),
  )
  .superRefine((data, ctx) => {
    if (data.delayType === waitStepDelayTypes.enum.event) {
      if (
        data.eventType === waitStepEventTypes.enum.tagApplied &&
        !data.tagId
      ) {
        ctx.addIssue({ code: "custom", path: ["tagId"], message: "Required" })
      }
      if (
        data.eventType === waitStepEventTypes.enum.customFieldChanged &&
        !data.customFieldId
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["customFieldId"],
          message: "Required",
        })
      }
      if (
        data.eventType === waitStepEventTypes.enum.tagApplied &&
        data.matchValue
      ) {
        // A tag event carries no value to compare.
        ctx.addIssue({
          code: "custom",
          path: ["matchValue"],
          message: "Only a custom field change can match a value",
        })
      }
    }

    if (
      data.delayType === waitStepDelayTypes.enum.random &&
      data.min > data.max
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["max"],
        message: "Max must be ≥ Min",
      })
    }

    if (data.delayType === waitStepDelayTypes.enum.date) {
      if (data.dateType === waitStepDateTypes.enum.specific && !data.datetime) {
        ctx.addIssue({
          code: "custom",
          path: ["datetime"],
          message: "Required",
        })
      }
      if (
        data.dateType === waitStepDateTypes.enum.dynamic &&
        !data.outputFieldId
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["outputFieldId"],
          message: "Required",
        })
      }
    }

    if (data.delayType === waitStepDelayTypes.enum.duration && data.interval) {
      if (!data.startTime) {
        ctx.addIssue({
          code: "custom",
          path: ["startTime"],
          message: "Required when interval is enabled",
        })
      }
      if (!data.endTime) {
        ctx.addIssue({
          code: "custom",
          path: ["endTime"],
          message: "Required when interval is enabled",
        })
      }
    }
  })

export type WaitStepSchema = z.infer<typeof waitStepSchema>

export const waitStepDefaultFn = (): WaitStepSchema => ({
  id: createId(),
  stepType: stepTypes.enum.wait,
  delayType: waitStepDelayTypes.enum.duration,
  ...delayTypeDurationDefaultFn(),
})

export const delayTypeDurationDefaultFn = () => ({
  duration: 1,
  unit: waitStepDelayUnits.enum.hours,
  interval: false,
  startTime: null,
  endTime: null,
})

export const delayTypeEventDefaultFn = () => ({
  eventType: waitStepEventTypes.enum.tagApplied,
  tagId: "",
  customFieldId: "",
  matchValue: "",
  timeoutValue: 1,
  timeoutUnit: waitStepDelayUnits.enum.days,
  states: [successStateDefaultFn(), skipStateDefaultFn()] as [
    SuccessStateSchema,
    SkipStateSchema,
  ],
})

/**
 * The spec a parked row stores, from an `event` wait step; null for any other
 * delayType. `resolvedMatchValue` is the step's matchValue with its variables
 * already resolved for this contact (the caller resolves; this stays pure).
 */
export const waitForEventSpecFromStep = (
  step: WaitStepSchema,
  resolvedMatchValue?: string,
): WaitForEventSpec | null => {
  if (step.delayType !== waitStepDelayTypes.enum.event) {
    return null
  }
  if (step.eventType === waitStepEventTypes.enum.tagApplied) {
    return { eventType: step.eventType, tagId: step.tagId }
  }
  return step.matchValue
    ? {
        eventType: step.eventType,
        customFieldId: step.customFieldId,
        matchValue: (resolvedMatchValue ?? step.matchValue).slice(
          0,
          MATCH_VALUE_MAX,
        ),
      }
    : { eventType: step.eventType, customFieldId: step.customFieldId }
}

export const buildJobId = (rowId: string, triggerAt: Date) =>
  `smart-delay-${rowId}-${triggerAt.getTime()}`

export async function computeTriggerAt(
  step: WaitStepSchema,
  getCustomFieldValue?: (
    customFieldId: string,
  ) => Promise<string | null | undefined>,
): Promise<Date | null> {
  const timeToSeconds = (time: string) => {
    const [h = 0, m = 0, s = 0] = time.split(":").map(Number)
    return h * 3600 + m * 60 + s
  }

  const setTimeOfDay = (date: Date, totalSec: number) =>
    setMilliseconds(
      setSeconds(
        setMinutes(
          setHours(date, Math.floor(totalSec / 3600)),
          Math.floor((totalSec % 3600) / 60),
        ),
        totalSec % 60,
      ),
      0,
    )

  const getTimeOfDay = (d: Date) =>
    d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()

  if (step.delayType === waitStepDelayTypes.enum.duration) {
    const unitMs = delayUnitToMs(step.unit)
    const base = addMilliseconds(Date.now(), step.duration * unitMs)

    if (!(step.interval && step.startTime && step.endTime)) {
      return base
    }

    const windowStart = timeToSeconds(step.startTime)
    const windowEnd = timeToSeconds(step.endTime)
    const current = getTimeOfDay(base)
    const isOvernightWindow = windowStart > windowEnd

    if (isOvernightWindow) {
      // Valid when current >= 22:00 OR current <= 06:00
      const insideWindow = current >= windowStart || current <= windowEnd
      return insideWindow ? base : setTimeOfDay(base, windowStart)
    }

    if (current < windowStart) {
      return setTimeOfDay(base, windowStart)
    }
    if (current > windowEnd) {
      return setTimeOfDay(addDays(base, 1), windowStart)
    }
    return base
  }

  if (step.delayType === waitStepDelayTypes.enum.event) {
    // The timeout instant; the event itself resumes the row early.
    return addMilliseconds(
      Date.now(),
      step.timeoutValue * delayUnitToMs(step.timeoutUnit),
    )
  }

  if (step.delayType === waitStepDelayTypes.enum.random) {
    const unitMs = delayUnitToMs(step.unit)
    const rand = Math.floor(
      Math.random() * (step.max - step.min + 1) + step.min,
    )
    return addMilliseconds(Date.now(), rand * unitMs)
  }

  let triggerAt: Date | null = null
  if (step.delayType === waitStepDelayTypes.enum.date) {
    if (step.dateType === waitStepDateTypes.enum.specific) {
      if (!step.datetime) {
        return null
      }

      triggerAt = new Date(step.datetime)
    }

    if (step.dateType === waitStepDateTypes.enum.dynamic) {
      if (!(step.outputFieldId && getCustomFieldValue)) {
        return null
      }

      const raw = await getCustomFieldValue(step.outputFieldId)

      if (!raw) {
        return null
      }

      const parsed = new Date(raw)
      if (!isValid(parsed)) {
        return null
      }

      triggerAt = parsed

      if (
        step.offset &&
        step.offsetValue &&
        step.offsetUnit &&
        step.offsetOperator
      ) {
        const offsetMs = delayUnitToMs(step.offsetUnit)
        const sign =
          step.offsetOperator === waitStepOffsetOperators.enum.add ? 1 : -1
        triggerAt = addMilliseconds(
          triggerAt,
          sign * step.offsetValue * offsetMs,
        )
      }
    }
  }

  return triggerAt
}
