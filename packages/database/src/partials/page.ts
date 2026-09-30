import z from "zod"

/**
 * Custom expiring pages (roadmap B4): a workspace page whose `document` is an
 * EmailDocument v1 (@chatbotx.io/email-document, rendered with `renderWeb`),
 * reached by one contact through `/p/<token>` until the link expires.
 */
export const pageStatuses = z.enum(["active", "archived"])
export type PageStatus = z.infer<typeof pageStatuses>

export const PAGE_MAX_NAME = 120
/** Link lifetime bounds in hours: 1 hour .. 90 days, 7 days by default. */
export const PAGE_LINK_TTL_MIN_HOURS = 1
export const PAGE_LINK_TTL_MAX_HOURS = 2160
export const PAGE_LINK_TTL_DEFAULT_HOURS = 168
/** Expired links are kept this long (views stay auditable), then swept. */
export const PAGE_LINK_RETAIN_DAYS = 30
