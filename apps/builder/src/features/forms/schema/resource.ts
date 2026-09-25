import {
  FORM_MAX_TITLE,
  FORM_SLUG_REGEX,
  formStatuses,
} from "@chatbotx.io/database/partials"
import { zodBigintAsString } from "@chatbotx.io/utils"
import z from "zod"

/**
 * Wire shapes for the forms feature (s200). The definition and settings
 * jsonb are passed through as `unknown` on input (the business service is
 * the strict parser and names the failing path) and as the normalised
 * objects on output (`z.any()`: the client re-parses with the shared schema).
 */

export const formResource = z.object({
  id: z.string(),
  title: z.string(),
  slug: z.string(),
  status: formStatuses,
  definition: z.any(),
  publishedDefinition: z.any().nullable(),
  definitionVersion: z.number().int(),
  settings: z.any(),
  inboxId: z.string().nullable(),
  publishedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
})
export type FormResource = z.infer<typeof formResource>

export const formSummaryResource = formResource.extend({
  submissionCount: z.number().int(),
})
export type FormSummaryResource = z.infer<typeof formSummaryResource>

export const formSubmissionResource = z.object({
  id: z.string(),
  formId: z.string(),
  contactId: z.string().nullable(),
  definitionVersion: z.number().int(),
  values: z.record(z.string(), z.unknown()),
  visibility: z.object({
    steps: z.array(z.string()),
    fields: z.array(z.string()),
  }),
  userAgent: z.string().nullable(),
  createdAt: z.date(),
})
export type FormSubmissionResource = z.infer<typeof formSubmissionResource>

export const createFormRequest = z
  .object({
    title: z.string().trim().min(1).max(FORM_MAX_TITLE),
    slug: z.string().regex(FORM_SLUG_REGEX).optional(),
  })
  .strict()

export const updateFormRequest = z
  .object({
    title: z.string().trim().min(1).max(FORM_MAX_TITLE).optional(),
    slug: z.string().regex(FORM_SLUG_REGEX).optional(),
    definition: z.unknown().optional(),
    settings: z.unknown().optional(),
    inboxId: zodBigintAsString().nullable().optional(),
    force: z.boolean().optional(),
  })
  .strict()

export const setFormStatusRequest = z
  .object({ status: z.enum(["draft", "archived"]) })
  .strict()

export const listFormSubmissionsQuery = z
  .object({
    cursor: z.string().max(256).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict()
