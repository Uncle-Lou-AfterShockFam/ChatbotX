import { aiMcpServerService } from "@chatbotx.io/business"
import { assertCurrentUserCanAccessChatbot } from "@/lib/auth/utils"
import { withClientAuth } from "../lib/client-auth"
import type {
  ListAIMcpServersRequest,
  ListAIMcpServersResponse,
} from "../schema/action"

export async function listAIMcpServers(
  input: ListAIMcpServersRequest,
): Promise<ListAIMcpServersResponse & { pageCount: number }> {
  await assertCurrentUserCanAccessChatbot(input.workspaceId)

  const result = await aiMcpServerService.listAIMcpServers(input)
  // Rows go to the MCP table (RSC) and the oRPC list: never the stored
  // token or header values (s232a).
  return { ...result, data: result.data.map(withClientAuth) }
}
