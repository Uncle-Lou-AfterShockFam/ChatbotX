import {
  EMAIL_TEMPLATE_MAX_NAME,
  emailTemplateStatuses,
} from "@chatbotx.io/database/partials"
import z from "zod"

export const emailTemplateResource = z.object({
  id: z.string(),
  name: z.string(),
  /** An EmailDocument v1 (@chatbotx.io/email-document). */
  document: z.unknown(),
  status: emailTemplateStatuses,
  createdAt: z.date(),
  updatedAt: z.date(),
})
export type EmailTemplateResource = z.infer<typeof emailTemplateResource>

/**
 * The request body. `document` is validated by the service with
 * `parseDocument` (closed schema, size cap) so there is ONE validator; this
 * layer only bounds the shape.
 */
export const emailTemplateData = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(EMAIL_TEMPLATE_MAX_NAME)
      .describe("Template name, unique in the workspace."),
    document: z
      .record(z.string(), z.unknown())
      .describe(
        "An EmailDocument v1: { version: 1, settings: {...}, blocks: [...] } (see bulktext docs/B2-DOCUMENT-SCHEMA.md).",
      ),
  })
  .strict()

/** Sample merge values for a preview: bounded, never a contact's data. */
const PREVIEW_MAX_VARS = 50
const PREVIEW_MAX_VAR_LENGTH = 1000

export const emailTemplatePreviewInput = z
  .object({
    document: z
      .unknown()
      .describe(
        "A draft EmailDocument v1; validated by the service, issues come back with their path.",
      ),
    vars: z
      .record(z.string().max(200), z.string().max(PREVIEW_MAX_VAR_LENGTH))
      .refine((vars) => Object.keys(vars).length <= PREVIEW_MAX_VARS, {
        message: `At most ${PREVIEW_MAX_VARS} sample values`,
      })
      .optional()
      .describe("Sample merge values keyed by token name."),
  })
  .strict()

const renderAsset = z.object({
  url: z.string(),
  name: z.string(),
  size: z.number(),
  mimeType: z.string(),
})

export const emailTemplatePreviewResource = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    html: z.string(),
    text: z.string(),
    missing: z.array(z.string()),
    assets: z.record(z.string(), renderAsset),
  }),
  z.object({
    ok: z.literal(false),
    issues: z.array(z.object({ path: z.string(), message: z.string() })),
  }),
])
export type EmailTemplatePreviewResource = z.infer<
  typeof emailTemplatePreviewResource
>

/**
 * `includeArchived` from a JSON body (a boolean) or a query string, where
 * ONLY "true" / "false" are accepted: z.coerce.boolean() would turn
 * `?includeArchived=false` into true (any non-empty string).
 */
export const includeArchivedParam = z
  .union([
    z.boolean(),
    z.enum(["true", "false"]).transform((value) => value === "true"),
  ])
  .optional()
