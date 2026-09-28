import { withAuditContext } from "@chatbotx.io/business/audit"
import { ChatbotXException } from "@chatbotx.io/business/errors"
import { integrationQuickbooksService } from "@chatbotx.io/business/integration-quickbooks"
import {
  QUICKBOOKS_OAUTH_NONCE_COOKIE,
  verifyQuickbooksOAuthState,
} from "@chatbotx.io/encryption/quickbooks-oauth-state"
import { getPublicUrlFromRequest } from "@chatbotx.io/utils"
import { cookies } from "next/headers"
import { notFound, redirect } from "next/navigation"
import type { NextRequest } from "next/server"
import {
  quickbooksRedirectUri,
  quickbooksSettingsPath,
} from "@/features/integration-quickbooks/lib"
import { hasWorkspacePermission } from "@/lib/auth/permission-routes"
import {
  getCurrentUser,
  getCurrentUserAndTargetWorkspace,
} from "@/lib/auth/utils"
import { logger } from "@/lib/log"
import { getGuestClientIp } from "@/lib/rate-limit/guest-rate-limit"

/**
 * Intuit's OAuth redirect for a QuickBooks connect (s214b). Nothing is
 * exchanged unless the signed state verifies for THIS signed-in user, its
 * nonce equals the HttpOnly cookie the connect action set on this browser,
 * and the user is still a super admin of the state's workspace. The nonce
 * cookie is spent on the first use.
 */
export async function GET(request: NextRequest) {
  const url = new URL(getPublicUrlFromRequest(request))
  const user = await getCurrentUser()
  if (!user) {
    return notFound()
  }
  const jar = await cookies()
  const nonceCookie = jar.get(QUICKBOOKS_OAUTH_NONCE_COOKIE)?.value
  jar.set(QUICKBOOKS_OAUTH_NONCE_COOKIE, "", {
    path: "/integrations/quickbooks",
    maxAge: 0,
  })
  const state = await verifyQuickbooksOAuthState({
    state: url.searchParams.get("state"),
    nonceCookie,
    userId: user.id,
  })
  if (!state) {
    logger.info({ userId: user.id }, "quickbooks callback: state refused")
    return notFound()
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
    return notFound()
  }
  const back = quickbooksSettingsPath(state.workspaceId)
  const code = url.searchParams.get("code")
  const realmId = url.searchParams.get("realmId")
  if (url.searchParams.get("error") || !code || !realmId) {
    return redirect(`${back}?quickbooks=cancelled`)
  }
  let failure: "conflict" | "failed" | null = null
  try {
    await withAuditContext(
      {
        userId: user.id,
        workspaceId: state.workspaceId,
        ipAddress: getGuestClientIp(request.headers),
        userAgent: request.headers.get("user-agent") ?? undefined,
      },
      () =>
        integrationQuickbooksService.connect({
          workspaceId: state.workspaceId,
          code,
          realmId,
          redirectUri: quickbooksRedirectUri(),
        }),
    )
  } catch (error) {
    logger.error(
      { err: error, workspaceId: state.workspaceId },
      "quickbooks callback: connect failed",
    )
    // A closed code only: error text (SQL, ids) never goes into a URL.
    failure =
      error instanceof ChatbotXException && error.code === "conflict"
        ? "conflict"
        : "failed"
  }
  return redirect(
    failure ? `${back}?quickbooks=${failure}` : `${back}?quickbooks=connected`,
  )
}
