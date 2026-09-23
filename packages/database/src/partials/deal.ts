import z from "zod"

/**
 * Deal pipeline partials: the enums shared by the schema, the business layer,
 * the flow steps and the public API. Phase 1 = pipelines, stages, deals and
 * their activity log. Tasks, dependencies, comments with mentions and
 * per-pipeline members (round-robin) are phase 2 and get their own tables then.
 */

export const dealStatuses = z.enum(["open", "won", "lost"])
export type DealStatus = z.infer<typeof dealStatuses>

export const dealPriorities = z.enum(["low", "medium", "high"])
export type DealPriority = z.infer<typeof dealPriorities>

export const dealActivityTypes = z.enum([
  "created",
  "stageMoved",
  "valueChanged",
  "statusChanged",
  "priorityChanged",
  "assigned",
  "note",
])
export type DealActivityType = z.infer<typeof dealActivityTypes>

/** When a deal in this pipeline stops the contact's company (`stopCompany({reason: 'deal'})`). */
export const pipelineStopCompanyOn = z.enum(["none", "created", "won"])
export type PipelineStopCompanyOn = z.infer<typeof pipelineStopCompanyOn>

export const DEFAULT_DEAL_CURRENCY = "USD"

export const pipelineSettingsSchema = z.object({
  stopCompanyOn: pipelineStopCompanyOn.default("created"),
  defaultCurrency: z
    .string()
    .trim()
    .length(3)
    .toUpperCase()
    .default(DEFAULT_DEAL_CURRENCY),
})
export type PipelineSettings = z.infer<typeof pipelineSettingsSchema>
export type PipelineSettingsInput = z.input<typeof pipelineSettingsSchema>

export const DEFAULT_PIPELINE_SETTINGS: PipelineSettings = {
  stopCompanyOn: "created",
  defaultCurrency: DEFAULT_DEAL_CURRENCY,
}

/** The stages `pipelineService.create` seeds when none are given. */
export const DEFAULT_PIPELINE_STAGES = [
  {
    name: "New",
    color: "#64748b",
    probability: 10,
    isWon: false,
    isLost: false,
  },
  {
    name: "Qualified",
    color: "#3b82f6",
    probability: 50,
    isWon: false,
    isLost: false,
  },
  {
    name: "Won",
    color: "#22c55e",
    probability: 100,
    isWon: true,
    isLost: false,
  },
  {
    name: "Lost",
    color: "#ef4444",
    probability: 0,
    isWon: false,
    isLost: true,
  },
] as const

const MONEY_SEPARATORS = /[,\s_]/g

/** Money is stored as numeric(14,2); the app always compares the normalised string. */
export const DEAL_VALUE_SCALE = 2

/**
 * Normalise a money input to the exact string the database returns for
 * numeric(14,2), or null when the input is not a finite non-negative number.
 * Accepts "1,250.50", "1250.5", 1250.5; rejects "abc", NaN, negatives.
 */
export function normalizeDealValue(value: unknown): string | null {
  if (value === null || value === undefined || value === "") {
    return null
  }
  let asNumber = Number.NaN
  if (typeof value === "number") {
    asNumber = value
  } else if (typeof value === "string") {
    asNumber = Number(value.replace(MONEY_SEPARATORS, ""))
  }
  if (!Number.isFinite(asNumber) || asNumber < 0 || asNumber >= 1e12) {
    return null
  }
  return asNumber.toFixed(DEAL_VALUE_SCALE)
}
