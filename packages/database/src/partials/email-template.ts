import z from "zod"

/**
 * Newsletter / email templates (roadmap B2): per-workspace documents in the
 * `@chatbotx.io/email-document` format, picked by the flow `email` step.
 * Named `EmailTemplate` in SQL; code says `emailTemplateModel` because
 * `@chatbotx.io/mail` already exports a system-mail `EmailTemplate` type.
 */
export const emailTemplateStatuses = z.enum(["active", "archived"])
export type EmailTemplateStatus = z.infer<typeof emailTemplateStatuses>

export const EMAIL_TEMPLATE_MAX_NAME = 120
