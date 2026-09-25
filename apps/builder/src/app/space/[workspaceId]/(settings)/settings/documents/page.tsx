import { getIdFromParams } from "@chatbotx.io/utils"
import { notFound } from "next/navigation"
import { DocumentTemplatesSettings } from "@/features/documents/document-templates-settings"
import { requireContactsAccess } from "@/lib/auth/require-workspace-permission"

export default async function DocumentsSettingsPage(props: {
  params: Promise<{ workspaceId: string }>
}) {
  const workspaceId = getIdFromParams(await props.params, "workspaceId")
  if (!workspaceId) {
    return notFound()
  }
  await requireContactsAccess(workspaceId)
  return <DocumentTemplatesSettings workspaceId={workspaceId} />
}
