import type { DatabaseClient } from "@chatbotx.io/database/client"
import type { PipelineModel } from "@chatbotx.io/database/types"
import {
  assignedOnlyUserId,
  hasWorkspacePermission,
  type PermissionsInput,
} from "../workspace-member/permissions"
import { pipelineMemberService } from "./members"

/**
 * Who is reading (s193). Built by the private API middleware and the server
 * actions from the SAME member row the permission gate used; the public API
 * (workspace token, no member) never has one and is unscoped by design.
 */
export type DealViewer = { userId: string; permissions: PermissionsInput }

/** Owner id every deal read is restricted to; undefined = unrestricted. */
export function viewerOwnerFilter(viewer: DealViewer): string | undefined {
  return assignedOnlyUserId(viewer)
}

export function isUnrestrictedViewer(viewer: DealViewer): boolean {
  return hasWorkspacePermission(viewer.permissions, "superAdmin")
}

/**
 * `settings.access = "members"` hides the pipeline from everyone but its
 * members and super admins. Membership is one indexed lookup.
 */
export async function canViewPipeline(props: {
  viewer: DealViewer
  pipeline: Pick<PipelineModel, "id" | "workspaceId" | "settings">
  tx?: DatabaseClient
}): Promise<boolean> {
  const { viewer, pipeline, tx } = props
  if (pipeline.settings.access !== "members") {
    return true
  }
  if (isUnrestrictedViewer(viewer)) {
    return true
  }
  return await pipelineMemberService.isMember({
    workspaceId: pipeline.workspaceId,
    pipelineId: pipeline.id,
    userId: viewer.userId,
    tx,
  })
}
