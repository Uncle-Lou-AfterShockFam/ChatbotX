import { createId, zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"
import { stepTypes } from "./step-action"

export const MAX_DEAL_TITLE_LENGTH = 200

/** Mirrors `dealPriorities` in `@chatbotx.io/database/partials` (database depends on this package, not the reverse). */
export const createDealPriorities = z.enum(["low", "medium", "high"])

/**
 * Open a deal for the conversation's contact in a pipeline. `title` and
 * `value` may carry `{{variable}}` tokens (a custom field can drive the
 * amount); the worker resolves them before the deal is written. With
 * `skipIfOpenDealExists` (default on) a contact who already has an open deal
 * in that pipeline gets no second one.
 */
export const createDealStepSchema = z.object({
  id: zodBigintAsString(),
  stepType: z.literal(stepTypes.enum.createDeal),
  pipelineId: z.string().optional(),
  /** Empty = the pipeline's first stage. */
  stageId: z.string().optional(),
  title: z.string().trim().max(MAX_DEAL_TITLE_LENGTH).default(""),
  /** A number, or a token that resolves to one; empty = no value. */
  value: z.string().trim().max(64).default(""),
  /** 3-letter ISO code; empty = the pipeline's default currency. */
  currency: z.string().trim().max(3).default(""),
  priority: createDealPriorities.default("medium"),
  skipIfOpenDealExists: z.boolean().default(true),
  /** Workspace member id; empty = no owner. Never remapped on import (users are not exportable). */
  ownerId: z.string().optional(),
  /** Due date = now + N days at run time; null = no due date. */
  dueInDays: z.number().int().min(0).max(365).nullable().default(null),
})

export type CreateDealStepSchema = z.infer<typeof createDealStepSchema>

export const createDealStepDefaultFn = (): CreateDealStepSchema => ({
  id: createId(),
  stepType: stepTypes.enum.createDeal,
  pipelineId: undefined,
  stageId: undefined,
  title: "",
  value: "",
  currency: "",
  priority: "medium",
  skipIfOpenDealExists: true,
  ownerId: undefined,
  dueInDays: null,
})
