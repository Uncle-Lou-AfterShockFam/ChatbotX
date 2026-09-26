import { type DatabaseClient, db } from "../../client"

export const whatsappMessageTemplateRepository = {
  /**
   * Template ids for WhatsApp integrations, used to filter flows by their
   * start-step template (`sendWaTemplateMessage`). Kept minimal and
   * read-only — the meta-channels scope owns `syncForIntegration` and other
   * write paths for this table. Only integrations of `workspaceId` count:
   * the ids come from the caller, and the template table has no workspace.
   */
  async listIdsByIntegrations(
    input: { workspaceId: string; integrationWhatsappIds: string[] },
    tx: DatabaseClient = db,
  ): Promise<string[]> {
    if (input.integrationWhatsappIds.length === 0) {
      return []
    }
    const templates = await tx.query.whatsappMessageTemplateModel.findMany({
      where: {
        integrationWhatsappId: { in: input.integrationWhatsappIds },
        integrationWhatsapp: { workspaceId: input.workspaceId },
      },
      columns: { id: true },
    })
    return templates.map((t) => t.id)
  },
}
