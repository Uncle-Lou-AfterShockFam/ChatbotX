"use server"

import {
  buildQuickbooksAuthorizeUrl,
  quickbooksAppCredential,
} from "@chatbotx.io/business/integration-quickbooks"
import {
  mintQuickbooksOAuthNonce,
  QUICKBOOKS_OAUTH_NONCE_COOKIE,
  QUICKBOOKS_OAUTH_STATE_TTL_MS,
  signQuickbooksOAuthState,
} from "@chatbotx.io/encryption/quickbooks-oauth-state"
import { cookies } from "next/headers"
import { env } from "@/env"
import { workspaceIdrequestParams } from "@/features/common/schema"
import { hasWorkspacePermission } from "@/lib/auth/permission-routes"
import { workspaceActionClient } from "@/lib/safe-action"
import { quickbooksRedirectUri } from "../lib"

/**
 * Start a QuickBooks connect (s214b): the answer is Intuit's authorize URL.
 * Its `state` is signed and bound to this user and workspace, and its nonce
 * rides an HttpOnly cookie that only this browser sends back, so a code
 * cannot be replayed into another session or workspace.
 */
export const startQuickbooksConnectAction = workspaceActionClient
  .bindArgsSchemas(workspaceIdrequestParams)
  .action(async ({ ctx, bindArgsParsedInputs: [workspaceId] }) => {
    if (!hasWorkspacePermission(ctx.workspaceMemberPermissions, "superAdmin")) {
      throw new Error("You need to be a super admin to connect QuickBooks")
    }
    const app = await quickbooksAppCredential()
    const nonce = mintQuickbooksOAuthNonce()
    const state = await signQuickbooksOAuthState({
      workspaceId,
      userId: ctx.user.id,
      nonce,
    })
    ;(await cookies()).set(QUICKBOOKS_OAUTH_NONCE_COOKIE, nonce, {
      httpOnly: true,
      secure: env.NEXT_PUBLIC_BUILDER_URL.startsWith("https:"),
      sameSite: "lax",
      path: "/integrations/quickbooks",
      maxAge: Math.floor(QUICKBOOKS_OAUTH_STATE_TTL_MS / 1000),
    })
    return {
      url: buildQuickbooksAuthorizeUrl({
        clientId: app.clientId,
        redirectUri: quickbooksRedirectUri(),
        state,
      }),
    }
  })
