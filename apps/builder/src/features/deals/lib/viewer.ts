import type { DealViewer } from "@chatbotx.io/business"
import type { PermissionsInput } from "@chatbotx.io/business/workspace-member/permissions"

/**
 * The viewer every deal / pipeline read and write is scoped to (s193), built
 * from the SAME member row the permission gate resolved: oRPC handlers get
 * `context.member`, server actions get `ctx.workspaceMemberPermissions`.
 */
export function viewerFromContext(context: {
  user: { id: string }
  member: { permissions: PermissionsInput }
}): DealViewer {
  return { userId: context.user.id, permissions: context.member.permissions }
}

export function viewerFromActionCtx(ctx: {
  user: { id: string }
  workspaceMemberPermissions: PermissionsInput
}): DealViewer {
  return { userId: ctx.user.id, permissions: ctx.workspaceMemberPermissions }
}
