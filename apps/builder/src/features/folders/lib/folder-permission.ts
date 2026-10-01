import "server-only"

import { folderService } from "@chatbotx.io/business"
import type { FolderType } from "@chatbotx.io/database/partials"
import { flowsAccessRequired } from "@/lib/auth/flows-access"
import {
  hasWorkspacePermission,
  type PermissionsInput,
} from "@/lib/auth/permission-routes"

/**
 * The folder actions serve every folderable section. A flow folder belongs
 * to the flows section, so writing one needs the `flows` permission like
 * every other flow write (s234a); other folder types stay membership-only.
 */
const assertAllowed = (
  permissions: PermissionsInput,
  folderTypes: readonly FolderType[],
) => {
  if (
    folderTypes.includes("flow") &&
    !hasWorkspacePermission(permissions, "flows")
  ) {
    throw flowsAccessRequired()
  }
}

/** create / change-folder: the type is in the request. */
export const assertFolderTypeAccess = (
  permissions: PermissionsInput,
  folderType: FolderType,
) => assertAllowed(permissions, [folderType])

/**
 * edit / delete by id: the types of the targeted folders AND their
 * descendants - a delete cascades to the whole subtree.
 */
export async function assertFolderIdsAccess(props: {
  workspaceId: string
  permissions: PermissionsInput
  ids: readonly string[]
}): Promise<void> {
  const { workspaceId, permissions, ids } = props
  if (ids.length === 0 || hasWorkspacePermission(permissions, "flows")) {
    return
  }
  assertAllowed(
    permissions,
    await folderService.subtreeFolderTypes({ workspaceId, ids }),
  )
}
