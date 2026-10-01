import { platformCredentialService } from "@chatbotx.io/business"
import { withAuditContext } from "@chatbotx.io/business/audit"
import {
  emailSenderService,
  GoogleOAuthError,
} from "@chatbotx.io/business/email-sender"
import { ChatbotXException } from "@chatbotx.io/business/errors"
import {
  EMAIL_SENDER_OAUTH_COOKIE_PATH,
  EMAIL_SENDER_OAUTH_NONCE_COOKIE,
  verifyEmailSenderOAuthState,
} from "@chatbotx.io/encryption/email-sender-oauth-state"
import { getPublicUrlFromRequest } from "@chatbotx.io/utils"
import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { type NextRequest, NextResponse } from "next/server"
import {
  EMAIL_SENDER_CALLBACK_PATH,
  type EmailSenderConnectOutcome,
  emailSenderSettingsPath,
  outcomeOfGoogleError,
} from "@/features/email-senders/lib"
import { hasWorkspacePermission } from "@/lib/auth/permission-routes"
import {
  getCurrentUser,
  getCurrentUserAndTargetWorkspace,
} from "@/lib/auth/utils"
import { logger } from "@/lib/log"
import { resolvePlatformOwnerId } from "@/lib/platform-credential-owner"
import { buildProviderCallbackUrl } from "@/lib/provider-origin"
import { getGuestClientIp } from "@/lib/rate-limit/guest-rate-limit"

/** A connect failure as a closed code (never the error's text). */
function outcomeOfError(error: unknown): EmailSenderConnectOutcome {
  if (error instanceof GoogleOAuthError) {
    return error.message === "gmail-scope-not-granted" ? "scope" : "failed"
  }
  if (error instanceof ChatbotXException) {
    if (error.code === "emailSenderGoogleMismatch") {
      return "mismatch"
    }
    if (error.field === "address") {
      return "duplicate"
    }
  }
  return "failed"
}

/**
 * A refusal: a bare 404 that still clears the nonce cookie (review s230b:
 * Next drops the cookie jar's changes on a thrown `notFound()`, so the nonce
 * would outlive a refused callback).
 */
function refuse(): NextResponse {
  const response = new NextResponse(null, { status: 404 })
  response.cookies.set(EMAIL_SENDER_OAUTH_NONCE_COOKIE, "", {
    path: EMAIL_SENDER_OAUTH_COOKIE_PATH,
    maxAge: 0,
  })
  return response
}

/**
 * Google's OAuth redirect for a mailbox-sender connect (s230b). Nothing is
 * exchanged unless the signed state verifies for THIS signed-in user, its
 * nonce equals the HttpOnly cookie the connect action set on this browser,
 * and the user is still a super admin of the state's workspace. The nonce
 * cookie is spent on the first use.
 */
export async function GET(request: NextRequest) {
  const url = new URL(getPublicUrlFromRequest(request))
  const user = await getCurrentUser()
  if (!user) {
    return refuse()
  }
  const jar = await cookies()
  const nonceCookie = jar.get(EMAIL_SENDER_OAUTH_NONCE_COOKIE)?.value
  jar.set(EMAIL_SENDER_OAUTH_NONCE_COOKIE, "", {
    path: EMAIL_SENDER_OAUTH_COOKIE_PATH,
    maxAge: 0,
  })
  const state = await verifyEmailSenderOAuthState({
    state: url.searchParams.get("state"),
    nonceCookie,
    userId: user.id,
  })
  if (!state) {
    logger.info({ userId: user.id }, "email sender callback: state refused")
    return refuse()
  }
  const access = await getCurrentUserAndTargetWorkspace(state.workspaceId)
  if (
    !(
      access &&
      hasWorkspacePermission(
        access.targetWorkspaceMember.permissions,
        "superAdmin",
      )
    )
  ) {
    return refuse()
  }
  const back = emailSenderSettingsPath(state.workspaceId)
  const googleError = url.searchParams.get("error")
  const code = url.searchParams.get("code")
  if (googleError || !code) {
    return redirect(
      `${back}?emailSenderConnect=${googleError ? outcomeOfGoogleError(googleError) : "cancelled"}`,
    )
  }
  let outcome: EmailSenderConnectOutcome = "connected"
  try {
    const ownerId = await resolvePlatformOwnerId({
      userId: user.id,
      workspaceId: state.workspaceId,
    })
    const credential = await platformCredentialService.resolveForOwner({
      ownerId,
      type: "google",
    })
    const redirectUri = await buildProviderCallbackUrl(
      credential,
      EMAIL_SENDER_CALLBACK_PATH,
    )
    await withAuditContext(
      {
        userId: user.id,
        workspaceId: state.workspaceId,
        ipAddress: getGuestClientIp(request.headers),
        userAgent: request.headers.get("user-agent") ?? undefined,
      },
      () =>
        emailSenderService.connectGoogle(
          {
            workspaceId: state.workspaceId,
            lineInboxId: state.lineInboxId,
            ownerId,
            code,
            redirectUri,
            ...(state.senderId
              ? { senderId: state.senderId }
              : {
                  fromName: state.fromName,
                  firstName: state.firstName,
                  lastName: state.lastName,
                }),
          },
          user.id,
        ),
    )
  } catch (error) {
    outcome = outcomeOfError(error)
    logger.error(
      {
        workspaceId: state.workspaceId,
        outcome,
        err: error instanceof Error ? error.name : "unknown",
      },
      "email sender callback: connect failed",
    )
  }
  return redirect(`${back}?emailSenderConnect=${outcome}`)
}
