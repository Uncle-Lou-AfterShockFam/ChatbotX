import { dealPriorities, dealStatuses } from "@chatbotx.io/database/partials"
import { zodBigintAsString } from "@chatbotx.io/utils"
import z from "zod"

const money = z
  .union([z.string().trim().max(32), z.number()])
  .nullish()
  .describe("Deal amount as a number or numeric string; null clears it.")

const currency = z
  .string()
  .trim()
  .length(3)
  .nullish()
  .describe("3-letter ISO currency code; omitted = the pipeline default.")

export const createDealRequest = z.object({
  pipelineId: zodBigintAsString().describe("Pipeline the deal opens in."),
  stageId: zodBigintAsString()
    .nullish()
    .describe("Stage to land in; omitted = the pipeline's first stage."),
  title: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe("Deal title shown on the card."),
  value: money,
  currency,
  priority: dealPriorities
    .optional()
    .describe("low, medium (default) or high."),
  contactId: zodBigintAsString()
    .nullish()
    .describe(
      "Contact the deal belongs to; drives triggers and the company default.",
    ),
  companyId: zodBigintAsString()
    .nullish()
    .describe("Company of the deal; omitted = the contact's company."),
  ownerId: zodBigintAsString()
    .nullish()
    .describe("Workspace member (user id) who owns the deal."),
  dueAt: z.coerce.date().nullish().describe("Optional due date."),
  fields: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Free-form extra fields stored on the deal."),
})
export type CreateDealRequest = z.infer<typeof createDealRequest>

export const updateDealRequest = z.object({
  title: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe("New deal title shown on the card."),
  value: money,
  currency,
  priority: dealPriorities
    .optional()
    .describe("low, medium or high; a change emits ticketPriorityChanged."),
  ownerId: zodBigintAsString()
    .nullish()
    .describe(
      "Workspace member (user id) who owns the deal; null clears the owner.",
    ),
  dueAt: z.coerce
    .date()
    .nullish()
    .describe("Optional due date; null clears it."),
  fields: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Extra fields merged into the deal's fields."),
  contactId: zodBigintAsString()
    .nullish()
    .describe("Re-link the deal to this contact; null clears the link."),
  companyId: zodBigintAsString()
    .nullish()
    .describe("Re-link the deal to this company; null clears the link."),
})
export type UpdateDealRequest = z.infer<typeof updateDealRequest>

export const moveDealRequest = z.object({
  stageId: zodBigintAsString().describe(
    "Destination stage; must belong to the deal's pipeline.",
  ),
  position: z
    .number()
    .finite()
    .nullish()
    .describe("Sort position inside the stage; omitted = end of the column."),
})
export type MoveDealRequest = z.infer<typeof moveDealRequest>

/** s196: closed on purpose, an unknown key is a caller bug, never ignored. */
export const moveDealPipelineRequest = z
  .object({
    pipelineId: zodBigintAsString().describe(
      "Destination pipeline; must differ from the deal's current pipeline.",
    ),
    stageId: zodBigintAsString()
      .nullish()
      .describe(
        "Stage of the destination pipeline; omitted = its first stage.",
      ),
    fields: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "Merged into the deal's fields; must supply every required field of the destination pipeline the deal lacks.",
      ),
    ownerId: zodBigintAsString()
      .nullish()
      .describe(
        "New owner (user id); null clears it. Required when the current owner cannot see a members-only destination.",
      ),
  })
  .strict()
export type MoveDealPipelineRequest = z.infer<typeof moveDealPipelineRequest>

export const setDealStatusRequest = z.object({
  status: dealStatuses.describe(
    "open (reopen), won or lost; a closed deal must be reopened before switching between won and lost.",
  ),
})
export type SetDealStatusRequest = z.infer<typeof setDealStatusRequest>

export const addDealNoteRequest = z.object({
  text: z
    .string()
    .trim()
    .min(1)
    .max(4000)
    .describe("Note text appended to the deal's activity log."),
})
export type AddDealNoteRequest = z.infer<typeof addDealNoteRequest>

export const deleteDealsRequest = z.object({
  ids: z.array(zodBigintAsString()).min(1).max(100),
})
