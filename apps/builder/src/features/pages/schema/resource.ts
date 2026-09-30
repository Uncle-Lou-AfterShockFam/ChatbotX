import {
  PAGE_LINK_TTL_MAX_HOURS,
  PAGE_LINK_TTL_MIN_HOURS,
  PAGE_MAX_NAME,
  pageStatuses,
} from "@chatbotx.io/database/partials"
import z from "zod"
import {
  emailTemplatePreviewInput,
  renderAsset,
} from "@/features/email-templates/schema/resource"

export const pageResource = z.object({
  id: z.string(),
  name: z.string(),
  /** An EmailDocument v1 (@chatbotx.io/email-document), rendered with renderWeb. */
  document: z.unknown(),
  status: pageStatuses,
  linkTtlHours: z.number().int(),
  createdAt: z.date(),
  updatedAt: z.date(),
})
export type PageResource = z.infer<typeof pageResource>

/**
 * The request body. `document` is validated by the service (the same
 * parseDocument as email templates); this layer only bounds the shape.
 */
export const pageData = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(PAGE_MAX_NAME)
      .describe(
        "Page name, unique in the workspace. Shown as the browser tab title.",
      ),
    document: z
      .record(z.string(), z.unknown())
      .describe(
        "An EmailDocument v1: { version: 1, settings: {...}, blocks: [...] } (see bulktext docs/B2-DOCUMENT-SCHEMA.md).",
      ),
    linkTtlHours: z
      .number()
      .int()
      .min(PAGE_LINK_TTL_MIN_HOURS)
      .max(PAGE_LINK_TTL_MAX_HOURS)
      .describe("How long each contact's link stays open, in hours."),
  })
  .strict()

/** Same bounded draft + sample values as the email preview. */
export const pagePreviewInput = emailTemplatePreviewInput

export const pagePreviewResource = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    html: z.string(),
    missing: z.array(z.string()),
    assets: z.record(z.string(), renderAsset),
  }),
  z.object({
    ok: z.literal(false),
    issues: z.array(z.object({ path: z.string(), message: z.string() })),
  }),
])
