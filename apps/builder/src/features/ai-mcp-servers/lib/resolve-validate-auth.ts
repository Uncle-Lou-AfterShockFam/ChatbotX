import "server-only"

import { aiMcpServerService } from "@chatbotx.io/business"
import { ChatbotXException } from "@chatbotx.io/business/errors"
import type { ValidatePrivateAIMcpServerRequest } from "../schema/action"
import { keepsStoredSecret, mergeStoredAuth } from "./merge-stored-auth"

/**
 * The edit form never holds the stored secret, so an empty token or header
 * value validates against the stored one: only for a server of this
 * workspace and its stored URL (s232a). A blank with no stored server to keep it from fails.
 */
export const resolveValidateAuth = async (
  input: ValidatePrivateAIMcpServerRequest & { workspaceId: string },
) => {
  if (!keepsStoredSecret(input.auth)) {
    return input.auth
  }
  const stored = input.id
    ? await aiMcpServerService.findBy({
        where: { id: input.id, workspaceId: input.workspaceId },
      })
    : undefined
  const merged = mergeStoredAuth(input.auth, input.url, stored)
  if (merged.status === "missing") {
    throw new ChatbotXException(
      "Unable to validate MCP server.",
      "invalidMcpAuth",
      400,
    )
  }
  return merged.auth
}
