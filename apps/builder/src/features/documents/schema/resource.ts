import {
  CONTACT_DOCUMENT_REF_REGEX,
  contactDocumentStatuses,
  DOCUMENT_TEMPLATE_MAX_HTML_BYTES,
  DOCUMENT_TEMPLATE_MAX_NAME,
  documentTemplateStatuses,
} from "@chatbotx.io/database/partials"
import { zodBigintAsString } from "@chatbotx.io/utils"
import z from "zod"

export const documentTemplateResource = z.object({
  id: z.string(),
  name: z.string(),
  bodyHtml: z.string(),
  status: documentTemplateStatuses,
  createdAt: z.date(),
  updatedAt: z.date(),
})
export type DocumentTemplateResource = z.infer<typeof documentTemplateResource>

export const contactDocumentResource = z.object({
  id: z.string(),
  title: z.string(),
  ref: z.string(),
  status: contactDocumentStatuses,
  templateId: z.string().nullable(),
  fileSize: z.number().int().nullable(),
  /** `${appUrl}/f/<token>`: unauthenticated, valid until `linkExpiresAt`. */
  downloadUrl: z.string(),
  linkExpiresAt: z.date(),
  signingUrl: z.string().nullable(),
  signedAt: z.date().nullable(),
  createdAt: z.date(),
})
export type ContactDocumentResource = z.infer<typeof contactDocumentResource>

export const documentTemplateData = z
  .object({
    name: z.string().trim().min(1).max(DOCUMENT_TEMPLATE_MAX_NAME),
    bodyHtml: z.string().min(1).max(DOCUMENT_TEMPLATE_MAX_HTML_BYTES),
  })
  .strict()

export const generateContactDocumentRequest = z
  .object({
    templateId: zodBigintAsString(),
    ref: z.string().regex(CONTACT_DOCUMENT_REF_REGEX).optional(),
  })
  .strict()
