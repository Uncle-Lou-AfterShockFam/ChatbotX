import {
  DEAL_FIELD_KEY,
  dealFieldTypes,
  MAX_DEAL_FIELD_DEFS,
  MAX_DEAL_FIELD_OPTIONS,
  pipelineStopCompanyOn,
} from "@chatbotx.io/database/partials"
import { zodBigintAsString } from "@chatbotx.io/utils"
import z from "zod"

/**
 * API shape of one custom deal field; the closed partial schema
 * (`dealFieldDefsSchema`) re-validates the whole list server-side, so the
 * select/options and duplicate-key rules live there, not here.
 */
export const dealFieldDefInput = z
  .object({
    key: z
      .string()
      .regex(DEAL_FIELD_KEY)
      .describe(
        "Stable camelCase key the API and flows use for this field (letters, digits, underscore; max 40).",
      ),
    label: z
      .string()
      .trim()
      .min(1)
      .max(60)
      .describe(
        "Label people see for this field in the deal drawer and the create dialog.",
      ),
    type: dealFieldTypes.describe(
      "Value type: shortText, longText, number, date (ISO yyyy-mm-dd), boolean or select.",
    ),
    options: z
      .array(z.string().trim().min(1).max(60))
      .max(MAX_DEAL_FIELD_OPTIONS)
      .optional()
      .describe(
        "Allowed values for a select field (required for select, forbidden otherwise).",
      ),
    required: z
      .boolean()
      .optional()
      .describe(
        "When true a new deal must carry a value for this field (default false).",
      ),
  })
  .strict()
  .describe(
    "One custom deal field definition: key, label, type, select options and whether it is required.",
  )

export const pipelineSettingsInput = z
  .object({
    stopCompanyOn: pipelineStopCompanyOn
      .optional()
      .describe(
        "When a deal in this pipeline stops the contact's company: never, when a deal is created (default), or when a deal is won.",
      ),
    defaultCurrency: z
      .string()
      .trim()
      .length(3)
      .optional()
      .describe(
        "3-letter ISO currency code a new deal gets when none is given (default USD).",
      ),
    fieldDefs: z
      .array(dealFieldDefInput)
      .max(MAX_DEAL_FIELD_DEFS)
      .optional()
      .describe(
        "Custom deal fields every deal in this pipeline can carry (max 30); replaces the whole list.",
      ),
  })
  .strict()

export const pipelineStageInput = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .describe("Stage name shown as the board column header."),
  color: z
    .string()
    .trim()
    .max(32)
    .nullish()
    .describe("Optional CSS color for the stage header, e.g. #22c55e."),
  probability: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe("Informational win probability of deals in this stage, 0-100."),
  isWon: z
    .boolean()
    .optional()
    .describe("A deal moved onto this stage is marked won and closed."),
  isLost: z
    .boolean()
    .optional()
    .describe("A deal moved onto this stage is marked lost and closed."),
})
export type PipelineStageInput = z.infer<typeof pipelineStageInput>

const settingsField = pipelineSettingsInput
  .optional()
  .describe(
    "Pipeline settings: stopCompanyOn (none | created | won), defaultCurrency (3-letter ISO code) and fieldDefs (custom deal fields).",
  )

export const createPipelineRequest = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .describe("Pipeline name, unique per workspace."),
  settings: settingsField,
  stages: z
    .array(pipelineStageInput)
    .min(1)
    .max(30)
    .optional()
    .describe("Initial stages in order; omitted = New, Qualified, Won, Lost."),
})
export type CreatePipelineRequest = z.infer<typeof createPipelineRequest>

export const updatePipelineRequest = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .optional()
    .describe("New pipeline name, unique per workspace."),
  settings: settingsField,
})
export type UpdatePipelineRequest = z.infer<typeof updatePipelineRequest>

export const upsertStageRequest = pipelineStageInput.extend({
  stageId: zodBigintAsString().nullish(),
})
export type UpsertStageRequest = z.infer<typeof upsertStageRequest>

export const reorderStagesRequest = z.object({
  stageIds: z.array(zodBigintAsString()).min(1).max(30),
})

export const removeStageRequest = z.object({
  stageId: zodBigintAsString(),
  moveDealsTo: zodBigintAsString().nullish(),
})

export const deletePipelineRequest = z.object({
  force: z.boolean().optional(),
})
