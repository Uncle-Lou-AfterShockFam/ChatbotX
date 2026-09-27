import { createHmac } from "node:crypto"
import { z } from "zod"
import {
  signAppointmentToken,
  verifyAppointmentToken,
} from "./appointment-token-utils"
import { env } from "./keys"

const TOKEN_AAD = "dynamic-image-token"
/** Owner s214: long enough for platform re-fetches (Meta, Telegram, the line
 * worker) after a send; past it the link serves the plain background. */
export const DYNAMIC_IMAGE_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000

export const dynamicImageTokenPayloadSchema = z
  .object({
    workspaceId: z.string().min(1),
    dynamicImageId: z.string().min(1),
    contactId: z.string().min(1),
    contactInboxId: z.string().min(1),
    expiresAt: z.number(),
  })
  .strict()

export type DynamicImageTokenPayload = z.infer<
  typeof dynamicImageTokenPayloadSchema
>

/**
 * Signs the contact a Dynamic Image trigger link renders for (s214). The
 * public `/dynamic-images` route used to take a raw `userId` and look it up
 * as a `ContactInbox.sourceId` (a phone number on SMS lines), so anyone who
 * knew one could read that contact's variables off the image. The token is
 * encrypted and bound to one workspace, image and contact.
 */
export async function signDynamicImageToken(
  payload: Omit<DynamicImageTokenPayload, "expiresAt">,
  ttlMs = DYNAMIC_IMAGE_TOKEN_TTL_MS,
): Promise<string> {
  return await signAppointmentToken(
    { ...payload, expiresAt: Date.now() + ttlMs },
    TOKEN_AAD,
  )
}

/** Throws on a malformed, tampered, foreign-purpose or expired token. */
export async function verifyDynamicImageToken(
  token: string,
): Promise<DynamicImageTokenPayload> {
  return await verifyAppointmentToken(
    token,
    TOKEN_AAD,
    dynamicImageTokenPayloadSchema,
  )
}

/**
 * The unguessable, deterministic suffix of a contact's rendered image file.
 * The file is public-read, so its name must not be derivable from ids alone.
 */
export function dynamicImageContactFileTag(input: {
  workspaceId: string
  dynamicImageId: string
  contactId: string
}): string {
  return createHmac("sha256", Buffer.from(env.ENCRYPTION_KEY, "hex"))
    .update(
      `dynamic-image-file:${input.workspaceId}:${input.dynamicImageId}:${input.contactId}`,
    )
    .digest("hex")
    .slice(0, 32)
}
