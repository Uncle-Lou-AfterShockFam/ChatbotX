import "server-only"

import { ChatbotXException } from "@chatbotx.io/business/errors"
import { db } from "@chatbotx.io/database/client"
import type { FolderType } from "@chatbotx.io/database/partials"
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
    throw new ChatbotXException(
      "Flows access required",
      "flowsAccessRequired",
      403,
    )
  }
}

/** create / change-folder: the type is in the request. */
export const assertFolderTypeAccess = (
  permissions: PermissionsInput,
  folderType: FolderType,
) => assertAllowed(permissions, [folderType])

/** edit / delete by id: the types of the workspace's targeted folders. */
export async function assertFolderIdsAccess(props: {
  workspaceId: string
  permissions: PermissionsInput
  ids: readonly string[]
}): Promise<void> {
  const { workspaceId, permissions, ids } = props
  if (ids.length === 0 || hasWorkspacePermission(permissions, "flows")) {
    return
  }
  const rows = await db.query.folderModel.findMany({
    where: { workspaceId, id: { in: [...ids] } },
    columns: { folderType: true },
  })
  assertAllowed(
    permissions,
    rows.map((row) => row.folderType as FolderType),
  )
}
