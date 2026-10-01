import "server-only"

import {
  invitationService,
  userService,
  workspaceService,
} from "@chatbotx.io/business"
import type { InvitationView } from "../types"

/**
 * `null` for an unknown or expired code, or a deleted inviter: the page shows
 * one invalid-invitation card for all of them (s233a; it was a 500), so it is
 * not an oracle for which codes exist.
 */
export async function findInvitation({
  code,
}: {
  code: string
}): Promise<InvitationView | null> {
  const invitation = await invitationService.findByCode(code)
  if (!invitation || invitation.expiresAt < new Date()) {
    return null
  }

  const inviter = await userService.findNameAndEmail(invitation.invitedBy)
  if (!inviter) {
    return null
  }

  const workspace = invitation.workspaceId
    ? await workspaceService.find({ where: { id: invitation.workspaceId } })
    : undefined

  return {
    code: invitation.code,
    inviterName: inviter.name ?? null,
    workspace: workspace
      ? {
          name: workspace.name,
          logo: workspace.logo,
          scheduledDeletionAt: workspace.scheduledDeletionAt,
        }
      : null,
  }
}
