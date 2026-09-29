import { randomUUID } from "node:crypto"
import { encryptedDataSchema, encryptUtils } from "@chatbotx.io/encryption"
import { z } from "zod"

// A newsletter's button may be clicked long after the send, like its click links.
const TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000 // 1 year
/** Longer than any token this module mints; a bound on untrusted input. */
export const MAX_EMAIL_FLOW_TOKEN_LENGTH = 4096

const id = z.string().regex(/^\d{1,30}$/)
const emailFlowPayloadSchema = z
  .object({
    wid: id,
    fid: id,
    nid: id.optional(),
    cid: id,
    ciid: id,
    /**
     * The link's own id: what "once per link" claims (Codex s222b). Hashing
     * the token string instead let an equivalent encoding (base64 padding,
     * re-serialized JSON) claim a second start.
     */
    lid: z.string().uuid(),
    exp: z.number(),
  })
  .strict()
export type EmailFlowPayload = z.infer<typeof emailFlowPayloadSchema>

/**
 * B2 phase 4 (s222b): a newsletter button that STARTS A FLOW for the
 * recipient. A chat channel starts it by opening the chat with a ref
 * (`buildInboxLink`); an email-only contact (an SMTP or API-channel inbox) has
 * no chat to open, so the button carries this sealed token instead: the
 * workspace, the flow (and node), and the exact contact + contact inbox it
 * runs for. Authenticated encryption, so no field can be forged or swapped.
 */
export async function signEmailFlowToken(input: {
  workspaceId: string
  flowId: string
  nodeId?: string
  contactId: string
  contactInboxId: string
}): Promise<string> {
  const encrypted = await encryptUtils.encryptObject({
    wid: input.workspaceId,
    fid: input.flowId,
    ...(input.nodeId ? { nid: input.nodeId } : {}),
    cid: input.contactId,
    ciid: input.contactInboxId,
    lid: randomUUID(),
    exp: Date.now() + TOKEN_TTL_MS,
  })
  return Buffer.from(JSON.stringify(encrypted)).toString("base64url")
}

/**
 * The sealed flow start, or a throw: malformed, oversized, tampered or
 * expired. Callers treat any throw as "start nothing".
 */
export async function verifyEmailFlowToken(
  token: string,
): Promise<EmailFlowPayload> {
  if (token.length === 0 || token.length > MAX_EMAIL_FLOW_TOKEN_LENGTH) {
    throw new Error("Email flow token has an invalid length")
  }
  const json = Buffer.from(token, "base64url").toString("utf8")
  const encrypted = encryptedDataSchema.parse(JSON.parse(json))
  const payload = await encryptUtils.decryptObject(
    encrypted,
    emailFlowPayloadSchema,
  )
  if (payload.exp < Date.now()) {
    throw new Error("Email flow token has expired")
  }
  return payload
}
