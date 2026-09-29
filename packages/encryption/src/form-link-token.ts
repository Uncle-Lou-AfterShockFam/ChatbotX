import { z } from "zod"
import {
  signAppointmentToken,
  verifyAppointmentToken,
} from "./appointment-token-utils"

const TOKEN_AAD = "form-link-token"
/** s220c A2-4: a personal form link lives a week (a reminder can mint a fresh one). */
export const FORM_LINK_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** A caller may shorten it, never stretch it past this. */
export const FORM_LINK_TOKEN_MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000

export const formLinkTokenPayloadSchema = z
  .object({
    workspaceId: z.string().min(1),
    formId: z.string().min(1),
    contactId: z.string().min(1),
    expiresAt: z.number(),
  })
  .strict()

export type FormLinkTokenPayload = z.infer<typeof formLinkTokenPayloadSchema>

/**
 * Seals WHO a public form link was sent to (s220c A2-4): the page then knows
 * the contact (progressive profiling on the web) and the submission lands on
 * that contact instead of a lookup by the typed phone / email. Encrypted
 * (AES-GCM, purpose-bound AAD) and bound to one workspace, form and contact;
 * carried as `?k=`, which the edge strips from its access logs.
 */
export async function signFormLinkToken(
  payload: Omit<FormLinkTokenPayload, "expiresAt">,
  ttlMs = FORM_LINK_TOKEN_TTL_MS,
): Promise<string> {
  const ttl = Math.min(Math.max(ttlMs, 1), FORM_LINK_TOKEN_MAX_TTL_MS)
  return await signAppointmentToken(
    { ...payload, expiresAt: Date.now() + ttl },
    TOKEN_AAD,
  )
}

/** Throws on a malformed, tampered, foreign-purpose or expired token. */
export async function verifyFormLinkToken(
  token: string,
): Promise<FormLinkTokenPayload> {
  return await verifyAppointmentToken(
    token,
    TOKEN_AAD,
    formLinkTokenPayloadSchema,
  )
}

/**
 * The contact a `k` names FOR THIS FORM, or null. Never throws: a missing,
 * malformed, expired, foreign-purpose or foreign-form token just means an
 * anonymous visitor (the page still works).
 */
export async function contactFromFormLink(
  token: unknown,
  expected: { workspaceId: string; formId: string },
): Promise<string | null> {
  if (typeof token !== "string" || token.length === 0 || token.length > 4096) {
    return null
  }
  const payload = await verifyFormLinkToken(token).catch(() => null)
  if (
    payload === null ||
    payload.workspaceId !== expected.workspaceId ||
    payload.formId !== expected.formId
  ) {
    return null
  }
  return payload.contactId
}
