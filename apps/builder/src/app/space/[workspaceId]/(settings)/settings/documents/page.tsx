import { getIdFromParams } from "@chatbotx.io/utils"
import { notFound } from "next/navigation"
import { CustomFieldStoreProvider } from "@/features/custom-fields/provider/custom-field-store-context"
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
  // The editor's "Insert field" picker reads the custom-field store (s199:
  // without this provider "New template" crashed to the error boundary).
  return (
    <CustomFieldStoreProvider workspaceId={workspaceId}>
      <DocumentTemplatesSettings workspaceId={workspaceId} />
    </CustomFieldStoreProvider>
  )
}
