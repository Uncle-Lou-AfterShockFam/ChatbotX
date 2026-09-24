import {
  isWorkspaceScheduledForDeletion,
  resolveWorkspaceAccess,
  workspaceMemberService,
} from "@chatbotx.io/business"
import { withAuditContext } from "@chatbotx.io/business/audit"
import { hasContactsAccess } from "@chatbotx.io/business/workspace-member/permissions"
import { ORPCError } from "@orpc/server"
import { auth } from "@/lib/auth/auth"
import { getGuestClientIp } from "@/lib/rate-limit/guest-rate-limit"
import { assertWorkspaceOwnerAccessForMethod } from "@/lib/workspace/authorize-workspace-access"
import { base } from "./context"

export const authMiddleware = base.middleware(async ({ context, next }) => {
  const sessionData = await auth.api.getSession({
    headers: context.headers,
  })

  if (!(sessionData?.session && sessionData?.user)) {
    throw new ORPCError("UNAUTHORIZED")
  }

  // Forced-password-change gate for the whole oRPC surface. A reseller-
  // provisioned user holding a temporary password is redirected to
  // /auth/change-password by the RSC layouts, but a stale session could still
  // call an RPC/OpenAPI handler directly. Mirrors the server-action gate in
  // `safe-action.ts`. The change-password flow uses better-auth + a server
  // action (not oRPC), so nothing here needs to stay callable while flagged.
  if (sessionData.user.mustChangePassword) {
    throw new ORPCError("FORBIDDEN", { message: "Password change required" })
  }

  // Adds session and user to the context
  return next({
    context: {
      session: sessionData.session,
      user: {
        ...sessionData.user,
        image: sessionData.user.image || null,
        isAnonymous: sessionData.user.isAnonymous ?? false,
        mustChangePassword: sessionData.user.mustChangePassword ?? false,
        // stripeCustomerId: sessionData.user.stripeCustomerId || null,
      },
    },
  })
})

/**
 * Workspace membership gate for private oRPC routes. `requireContactsAccess`
 * adds the contacts-section rule (`contacts` or `onlyAssignedContacts`) that
 * the sidebar already applies, so a member without it cannot reach the data
 * through the API either.
 */
const createWorkspaceAuthorizedMiddleware = (options: {
  requireContactsAccess: boolean
}) =>
  base.middleware(async ({ context, next, procedure }, workspaceId: string) => {
    if (!context.user) {
      throw new ORPCError("UNAUTHORIZED")
    }

    const realMembership = await workspaceMemberService.findMembership({
      workspaceId,
      userId: context.user.id,
    })

    const access = await resolveWorkspaceAccess({
      realMember: realMembership,
      workspaceId,
      user: context.user,
    })

    if (!access) {
      throw new ORPCError("UNAUTHORIZED")
    }

    const { workspace, member } = access

    if (
      options.requireContactsAccess &&
      !hasContactsAccess(member.permissions)
    ) {
      throw new ORPCError("FORBIDDEN", { message: "Contacts access required" })
    }

    if (isWorkspaceScheduledForDeletion(workspace)) {
      throw new ORPCError("FORBIDDEN", {
        message: "Workspace deletion scheduled",
      })
    }

    // Owner-quota/trial gate — mirrors workspaceActionClient in safe-action.ts.
    // Reads and deletes stay open (invariant #14).
    await assertWorkspaceOwnerAccessForMethod({
      method: procedure["~orpc"].route.method,
      ownerId: workspace.ownerId,
    })

    return withAuditContext(
      {
        userId: context.user.id,
        workspaceId: workspace.id,
        ipAddress:
          context.session?.ipAddress ?? getGuestClientIp(context.headers),
        userAgent:
          context.session?.userAgent ??
          context.headers.get("user-agent") ??
          undefined,
      },
      () =>
        next({
          context: {
            workspace,
          },
        }),
    )
  })

export const workspaceAuthorizedMidddleware =
  createWorkspaceAuthorizedMiddleware({ requireContactsAccess: false })

/** Deals, pipelines: the contacts-section permission gates the API as well as the nav. */
export const contactsAccessAuthorizedMiddleware =
  createWorkspaceAuthorizedMiddleware({ requireContactsAccess: true })
