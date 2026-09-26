import z from "zod"

/**
 * Documents (roadmap B3): per-workspace HTML templates with `{{variable}}`
 * merge fields, rendered per contact to a PDF (Gotenberg) and stored as a
 * private file on the contact. The signing columns on ContactDocument are
 * filled by the Documenso step (B6 in the hub).
 */

export const documentTemplateStatuses = z.enum(["active", "archived"])
export type DocumentTemplateStatus = z.infer<typeof documentTemplateStatuses>

export const contactDocumentStatuses = z.enum([
  "generated",
  "sent",
  "signed",
  "failed",
])
export type ContactDocumentStatus = z.infer<typeof contactDocumentStatuses>

/** Template body cap: the editor output, before merge. */
export const DOCUMENT_TEMPLATE_MAX_HTML_BYTES = 200_000
export const DOCUMENT_TEMPLATE_MAX_NAME = 120
/** A caller-chosen idempotency key per contact (flow runs, API retries). */
export const CONTACT_DOCUMENT_REF_REGEX = /^[A-Za-z0-9._:-]{1,100}$/
/**
 * Generation budget per workspace: every render is a headless Chromium run on
 * the ONE shared Gotenberg, so one workspace (or one leaked token) may not
 * starve the rest.
 */
export const DOCUMENT_GENERATE_PER_MINUTE = 30
/**
 * Refs the hub reserves for its own invoice / receipt PDFs (s210b): a caller
 * may not plant one, and their renders (reachable by an anonymous pay link)
 * have a budget of their own so they cannot starve template generation.
 */
export const INVOICE_DOCUMENT_REF_PREFIX = "invoice:"
export const INVOICE_DOCUMENT_GENERATE_PER_MINUTE = 30
/** Download link lifetime for a generated document. */
export const CONTACT_DOCUMENT_LINK_TTL_DAYS = 30
