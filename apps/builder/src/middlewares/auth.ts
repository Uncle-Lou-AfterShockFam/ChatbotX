import {
  isWorkspaceScheduledForDeletion,
  resolveWorkspaceAccess,
  workspaceMemberService,
} from "@chatbotx.io/business"
import { withAuditContext } from "@chatbotx.io/business/audit"
import {
  hasContactsAccess,
  hasWorkspacePermission,
  type WorkspacePermissionKey,
} from "@chatbotx.io/business/workspace-member/permissions"
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
  requireSuperAdmin?: boolean
  requirePermission?: WorkspacePermissionKey
  /**
   * s231b (owner 2026-10-01): refuse a platform-support session (its
   * membership is synthetic, with superAdmin) - for routes that write
   * credentials into the customer's workspace.
   */
  rejectSupportSession?: boolean
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

    if (options.rejectSupportSession && access.isSupportSession) {
      throw new ORPCError("FORBIDDEN", {
        message: "Platform support sessions cannot change credentials",
      })
    }

    if (
      options.requireContactsAccess &&
      !hasContactsAccess(member.permissions)
    ) {
      throw new ORPCError("FORBIDDEN", { message: "Contacts access required" })
    }

    if (
      options.requireSuperAdmin &&
      !hasWorkspacePermission(member.permissions, "superAdmin")
    ) {
      throw new ORPCError("FORBIDDEN", {
        message: "Workspace admin access required",
      })
    }

    if (
      options.requirePermission &&
      !hasWorkspacePermission(member.permissions, options.requirePermission)
    ) {
      throw new ORPCError("FORBIDDEN", {
        message: `Workspace ${options.requirePermission} access required`,
      })
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
            // s193: the member row the gate used, so deal / pipeline handlers
            // can scope reads (`onlyAssignedContacts`, members-only pipelines)
            // without a second lookup.
            member,
          },
        }),
    )
  })

export const workspaceAuthorizedMidddleware =
  createWorkspaceAuthorizedMiddleware({ requireContactsAccess: false })

/** Deals, pipelines: the contacts-section permission gates the API as well as the nav. */
export const contactsAccessAuthorizedMiddleware =
  createWorkspaceAuthorizedMiddleware({ requireContactsAccess: true })

/**
 * s231b: the same, and never a platform-support session - for the routes that
 * WRITE mailbox credentials (add a sender, edit its login). Pausing and
 * archiving stay on the plain super-admin gate so support can stop a mailbox.
 */
export const superAdminRealMemberMiddleware =
  createWorkspaceAuthorizedMiddleware({
    requireContactsAccess: false,
    requireSuperAdmin: true,
    rejectSupportSession: true,
  })

/**
 * Workspace settings that hold credentials (s229b mailbox senders): admins
 * and owners only, the same `superAdmin` rule the Settings layout applies.
 */
export const superAdminAuthorizedMiddleware =
  createWorkspaceAuthorizedMiddleware({
    requireContactsAccess: false,
    requireSuperAdmin: true,
  })

/**
 * AI tools (files, functions, MCP servers): the `flows` permission the `(ai)`
 * layout already applies (s233a). The AI agents list stays on
 * `workspaceAuthorizedMidddleware`: the comment-automation forms (membership
 * only) pick an agent from it.
 */
export const flowsAuthorizedMiddleware = createWorkspaceAuthorizedMiddleware({
  requireContactsAccess: false,
  requirePermission: "flows",
})
