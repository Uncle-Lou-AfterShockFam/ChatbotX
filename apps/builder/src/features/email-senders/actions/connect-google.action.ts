"use server"

import { platformCredentialService } from "@chatbotx.io/business"
import {
  buildGoogleSenderAuthorizeUrl,
  emailSenderService,
} from "@chatbotx.io/business/email-sender"
import { ChatbotXException } from "@chatbotx.io/business/errors"
import {
  EMAIL_SENDER_OAUTH_COOKIE_PATH,
  EMAIL_SENDER_OAUTH_NONCE_COOKIE,
  EMAIL_SENDER_OAUTH_STATE_TTL_MS,
  mintEmailSenderOAuthNonce,
  signEmailSenderOAuthState,
} from "@chatbotx.io/encryption/email-sender-oauth-state"
import { cookies } from "next/headers"
import z from "zod"
import { env } from "@/env"
import { workspaceIdrequestParams } from "@/features/common/schema"
import { hasWorkspacePermission } from "@/lib/auth/permission-routes"
import { resolvePlatformOwnerId } from "@/lib/platform-credential-owner"
import { buildProviderCallbackUrl } from "@/lib/provider-origin"
import { workspaceActionClient } from "@/lib/safe-action"
import { EMAIL_SENDER_CALLBACK_PATH } from "../lib"

const id = z.string().regex(/^\d{1,19}$/)
const name = z.string().trim().min(1).max(100)

/** Either the sender to reconnect, or the identity of a new one. */
const connectGoogleRequest = z.union([
  z.object({ lineInboxId: id, senderId: id }).strict(),
  z
    .object({
      lineInboxId: id,
      fromName: name,
      firstName: name,
      lastName: name,
    })
    .strict(),
])

/**
 * Start a Google mailbox-sender connect (s230b); the answer is Google's
 * consent URL. Super admins only (a sender holds mailbox credentials). The
 * `state` is signed and bound to this user, workspace and line, and its
 * nonce rides an HttpOnly cookie only this browser sends back.
 */
export const startEmailSenderGoogleConnectAction = workspaceActionClient
  .bindArgsSchemas(workspaceIdrequestParams)
  .inputSchema(connectGoogleRequest)
  .action(async ({ ctx, parsedInput, bindArgsParsedInputs: [workspaceId] }) => {
    if (!hasWorkspacePermission(ctx.workspaceMemberPermissions, "superAdmin")) {
      throw new ChatbotXException(
        "You need to be a super admin to manage email senders",
        "emailSenderSuperAdminRequired",
        403,
      )
    }
    const lines = await emailSenderService.listLines({ workspaceId })
    if (!lines.some((line) => line.id === parsedInput.lineInboxId)) {
      throw new ChatbotXException("Email line not found", "notFound", 404)
    }
    let loginHint: string | undefined
    if ("senderId" in parsedInput) {
      const senders = await emailSenderService.list({
        workspaceId,
        lineInboxId: parsedInput.lineInboxId,
      })
      const sender = senders.find((s) => s.id === parsedInput.senderId)
      if (sender?.provider !== "google_oauth") {
        throw new ChatbotXException("Email sender not found", "notFound", 404)
      }
      loginHint = sender.address
    }
    const ownerId = await resolvePlatformOwnerId({
      userId: ctx.user.id,
      workspaceId,
    })
    const credential = await platformCredentialService.resolveForOwner({
      ownerId,
      type: "google",
    })
    if (!credential?.config.clientId) {
      throw new ChatbotXException(
        "The Google app is not configured (Admin > Platform credentials)",
        "credentialMissing",
        400,
      )
    }
    const nonce = mintEmailSenderOAuthNonce()
    const state = await signEmailSenderOAuthState({
      ...parsedInput,
      workspaceId,
      userId: ctx.user.id,
      nonce,
    })
    ;(await cookies()).set(EMAIL_SENDER_OAUTH_NONCE_COOKIE, nonce, {
      httpOnly: true,
      secure: env.NEXT_PUBLIC_BUILDER_URL.startsWith("https:"),
      sameSite: "lax",
      path: EMAIL_SENDER_OAUTH_COOKIE_PATH,
      maxAge: Math.floor(EMAIL_SENDER_OAUTH_STATE_TTL_MS / 1000),
    })
    return {
      url: buildGoogleSenderAuthorizeUrl({
        clientId: credential.config.clientId,
        redirectUri: await buildProviderCallbackUrl(
          credential,
          EMAIL_SENDER_CALLBACK_PATH,
        ),
        state,
        loginHint,
      }),
    }
  })
