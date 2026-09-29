import { getIdFromParams } from "@chatbotx.io/utils"
import { notFound } from "next/navigation"
import { CustomFieldStoreProvider } from "@/features/custom-fields/provider/custom-field-store-context"
import { EmailTemplatesSettings } from "@/features/email-templates/components/email-templates-settings"
import { requireContactsAccess } from "@/lib/auth/require-workspace-permission"

export default async function EmailTemplatesSettingsPage(props: {
  params: Promise<{ workspaceId: string }>
}) {
  const workspaceId = getIdFromParams(await props.params, "workspaceId")
  if (!workspaceId) {
    return notFound()
  }
  await requireContactsAccess(workspaceId)
  // The rich-text "Insert field" picker reads the custom-field store.
  return (
    <CustomFieldStoreProvider workspaceId={workspaceId}>
      <EmailTemplatesSettings workspaceId={workspaceId} />
    </CustomFieldStoreProvider>
  )
}
