import { getIdFromParams } from "@chatbotx.io/utils"
import { notFound } from "next/navigation"
import { CustomFieldStoreProvider } from "@/features/custom-fields/provider/custom-field-store-context"
import { PagesSettings } from "@/features/pages/components/pages-settings"
import { requireContactsAccess } from "@/lib/auth/require-workspace-permission"

export default async function PagesSettingsPage(props: {
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
      <PagesSettings workspaceId={workspaceId} />
    </CustomFieldStoreProvider>
  )
}
