import {
  createSelectSchema,
  workspaceModel,
} from "@chatbotx.io/database/schema"
import { zodBigintAsString } from "@chatbotx.io/utils"
import z from "zod"

// `.omit({ token: true })`: Workspace.token is the deprecated, read-only
// legacy plaintext source for {{api_key}} — it must never round-trip through
// a client-facing resource. This is a live public API response shape
// (GET /v1/workspaces, GET /users/me/workspaces), so a bare
// createSelectSchema(workspaceModel) would otherwise leak it verbatim.
export const workspaceResource = createSelectSchema(workspaceModel, {
  id: zodBigintAsString(),
}).omit({ token: true })
export type WorkspaceResource = z.infer<typeof workspaceResource>

/**
 * A workspace row for a client component prop (s233a): the same `token`
 * omission as `workspaceResource`, at runtime. A `WorkspaceResource` prop type
 * alone does not stop the extra field from being serialized to the browser.
 */
export const toWorkspaceResource = <T extends { token?: unknown }>({
  token: _token,
  ...rest
}: T): Omit<T, "token"> => rest

export const withWorkspaceIdSchema = z.object({
  workspaceId: zodBigintAsString(),
})

export const withWorkspaceIdAndIdSchema = z.object({
  workspaceId: zodBigintAsString(),
  id: zodBigintAsString(),
})
