import { z } from "zod"

/**
 * Web forms (s200). The definition schema + evaluator live in
 * `@chatbotx.io/utils/form` (client-safe, shared with the public page); this
 * partial re-exports them and adds the persistence-side pieces: statuses, the
 * settings jsonb, slug rules, and the strict-write / lenient-read helpers the
 * pipeline `settings` column established (hotfix #27 rule: a read path must
 * never throw on a row an older build wrote).
 */
export * from "@chatbotx.io/utils/form"

import {
  EMPTY_FORM_DEFINITION,
  type FormDefinition,
  formDefinition,
} from "@chatbotx.io/utils/form"

export const formStatuses = z.enum(["draft", "published", "archived"])
export type FormStatus = z.infer<typeof formStatuses>

export const FORM_MAX_TITLE = 120
/** `demo-intake`: 1-64 chars, lower-case, digits and single dashes inside. */
export const FORM_SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
export const FORM_MAX_SUCCESS_MESSAGE = 1000
export const FORM_MAX_TAGS = 10
export const FORM_MAX_EMBED_ORIGINS = 10
export const FORM_MAX_PREFILL_KEYS = 20
/** Same key rule as a custom-field key / hub-connector field key. */
const FORM_PREFILL_KEY_REGEX = /^[a-z][a-z0-9_]{0,39}$/
/** `https://host[:port]` only: no path, no wildcard, no trailing slash. */
export const FORM_EMBED_ORIGIN_REGEX =
  /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?$|^http:\/\/localhost(:\d{1,5})?$/

const httpsUrl = z
  .string()
  .max(2000)
  .refine((v) => {
    try {
      const u = new URL(v)
      return u.protocol === "https:" || u.hostname === "localhost"
    } catch {
      return false
    }
  }, "Redirect URL must be https.")

export const formSettingsSchema = z
  .object({
    successMessage: z
      .string()
      .max(FORM_MAX_SUCCESS_MESSAGE)
      .default("Thank you, your answers were received."),
    redirectUrl: httpsUrl.nullable().default(null),
    tags: z
      .array(z.string().trim().min(1).max(50))
      .max(FORM_MAX_TAGS)
      .default([]),
    honeypot: z.boolean().default(true),
    submitLimitPerIpPerHour: z.number().int().min(1).max(1000).default(20),
    embedOrigins: z
      .array(z.string().regex(FORM_EMBED_ORIGIN_REGEX, "Origin only, https."))
      .max(FORM_MAX_EMBED_ORIGINS)
      .default([]),
    prefillKeys: z
      .array(z.string().regex(FORM_PREFILL_KEY_REGEX))
      .max(FORM_MAX_PREFILL_KEYS)
      .default([]),
  })
  .strict()
export type FormSettings = z.infer<typeof formSettingsSchema>
export type FormSettingsInput = z.input<typeof formSettingsSchema>

export const DEFAULT_FORM_SETTINGS: FormSettings = formSettingsSchema.parse({})

export type FormParseResult<T> =
  | { success: true; data: T }
  | { success: false; path: string; message: string }

/** Strict parse for a WRITE: unknown keys, caps and cross-refs all refuse. */
export function parseFormDefinition(
  input: unknown,
): FormParseResult<FormDefinition> {
  const parsed = formDefinition.safeParse(input)
  if (parsed.success) {
    return { success: true, data: parsed.data }
  }
  const issue = parsed.error.issues[0]
  return {
    success: false,
    path: issue?.path.map(String).join(".") ?? "",
    message: issue?.message ?? "Invalid form definition.",
  }
}

/** Lenient READ: a row that no longer parses renders as an empty form, never throws. */
export function normalizeFormDefinition(raw: unknown): FormDefinition {
  const parsed = formDefinition.safeParse(raw ?? EMPTY_FORM_DEFINITION)
  return parsed.success ? parsed.data : { ...EMPTY_FORM_DEFINITION }
}

export function parseFormSettings(
  input: unknown,
): FormParseResult<FormSettings> {
  const parsed = formSettingsSchema.safeParse(input ?? {})
  if (parsed.success) {
    return { success: true, data: parsed.data }
  }
  const issue = parsed.error.issues[0]
  return {
    success: false,
    path: issue?.path.map(String).join(".") ?? "settings",
    message: issue?.message ?? "Invalid form settings.",
  }
}

/** Lenient READ: unknown keys are dropped, missing keys get defaults, a bad value falls back. */
export function normalizeFormSettings(raw: unknown): FormSettings {
  const parsed = formSettingsSchema.safeParse(raw ?? {})
  if (parsed.success) {
    return parsed.data
  }
  const source =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {}
  const out: Record<string, unknown> = { ...DEFAULT_FORM_SETTINGS }
  for (const key of Object.keys(DEFAULT_FORM_SETTINGS)) {
    const one = formSettingsSchema.shape[
      key as keyof typeof formSettingsSchema.shape
    ].safeParse(source[key])
    if (one.success && source[key] !== undefined) {
      out[key] = one.data
    }
  }
  return out as FormSettings
}

/** `Demo intake!` -> `demo-intake`; empty input -> `form`. */
export function slugifyFormTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "")
  return slug === "" ? "form" : slug
}

/** What a submission stored about visibility at answer time. */
export type FormSubmissionVisibility = {
  steps: string[]
  fields: string[]
}
