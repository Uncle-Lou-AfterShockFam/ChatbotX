import type { WorkspaceMemberPermissions } from "@chatbotx.io/database/partials"

/**
 * Every `WorkspaceMemberPermissions` flag set to `true`. Used by the
 * superAdmin-invite helper and by the synthetic platform-support membership
 * (`buildSupportMembership` in `./synthetic.ts`) — both need a full-access
 * permission set with no read-only mode.
 */
export const FULL_WORKSPACE_MEMBER_PERMISSIONS: WorkspaceMemberPermissions =
  Object.freeze({
    superAdmin: true,
    analytics: true,
    flows: true,
    contacts: true,
    onlyAssignedContacts: true,
    emailAndPhone: true,
    broadcast: true,
    ecommerce: true,
  })

/**
 * Lives in the business layer so `whatsapp-call/voip-call-service.ts` can
 * reuse the ONE permission rule instead of duplicating it. `permissions`
 * accepts a possibly-partial object (the jsonb column defaults to `{}`) so a
 * missing key fails closed, never open.
 */
export type PermissionsInput =
  | WorkspaceMemberPermissions
  | Record<string, unknown>

export type WorkspacePermissionKey = keyof WorkspaceMemberPermissions

export function hasWorkspacePermission(
  permissions: PermissionsInput,
  key: WorkspacePermissionKey,
): boolean {
  return permissions.superAdmin === true || permissions[key] === true
}

/** Shared "Contacts / Inbox" access rule: full contacts access OR
 * assigned-only access; superAdmin bypasses via `hasWorkspacePermission`. */
export function hasContactsAccess(permissions: PermissionsInput): boolean {
  return (
    hasWorkspacePermission(permissions, "contacts") ||
    hasWorkspacePermission(permissions, "onlyAssignedContacts")
  )
}

/**
 * The user id every read must be restricted to when the member sees only the
 * records assigned to them (`onlyAssignedContacts` without full `contacts`
 * access); `undefined` = unrestricted. A super admin is never restricted.
 * Shared by the contacts list scope in the builder and the deal scope (s193)
 * so both surfaces apply the ONE rule.
 */
export function assignedOnlyUserId(input: {
  permissions: PermissionsInput
  userId: string
}): string | undefined {
  if (hasWorkspacePermission(input.permissions, "superAdmin")) {
    return
  }
  return hasWorkspacePermission(input.permissions, "onlyAssignedContacts")
    ? input.userId
    : undefined
}
