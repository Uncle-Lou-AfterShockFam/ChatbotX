import { resolveTenantSettings } from "@chatbotx.io/business"
import type { ContactDocumentModel } from "@chatbotx.io/database/types"
import type { ContactDocumentResource } from "../schema/resource"

/** The public `/f/<token>` URL on the workspace's own app host. */
export const contactDocumentDownloadUrl = (appUrl: string, token: string) =>
  new URL(`/f/${token}`, appUrl).toString()

export async function toContactDocumentResources(
  workspaceId: string,
  rows: ContactDocumentModel[],
): Promise<ContactDocumentResource[]> {
  if (rows.length === 0) {
    return []
  }
  const { appUrl } = await resolveTenantSettings({ workspaceId })
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    ref: row.ref,
    status: row.status,
    templateId: row.templateId,
    fileSize: row.fileSize,
    downloadUrl: contactDocumentDownloadUrl(appUrl, row.token),
    linkExpiresAt: row.tokenExpiresAt,
    signingUrl: row.signingUrl,
    signedAt: row.signedAt,
    createdAt: row.createdAt,
  }))
}
