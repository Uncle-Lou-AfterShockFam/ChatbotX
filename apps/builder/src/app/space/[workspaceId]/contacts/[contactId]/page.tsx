import { Button } from "@chatbotx.io/ui/components/ui/button"
import { getIdFromParams } from "@chatbotx.io/utils"
import { ArrowLeftIcon } from "lucide-react"
import Link from "next/link"
import { notFound } from "next/navigation"
import { getTranslations } from "next-intl/server"
import { ContactView } from "@/features/contacts/contact-view"
import { requireContactPermissionScope } from "@/features/contacts/permissions"
import { CustomFieldStoreProvider } from "@/features/custom-fields/provider/custom-field-store-context"
import { requireContactsAccess } from "@/lib/auth/require-workspace-permission"

/** Contact 360 page (s195). The data loads client-side through the crm routes. */
export default async function ContactPage(props: {
  params: Promise<{ workspaceId: string; contactId: string }>
}) {
  const params = await props.params
  const workspaceId = getIdFromParams(params, "workspaceId")
  const contactId = getIdFromParams(params, "contactId")
  if (!(workspaceId && contactId)) {
    return notFound()
  }
  await requireContactsAccess(workspaceId)
  await requireContactPermissionScope(workspaceId)
  const t = await getTranslations()

  return (
    <div className="space-y-4">
      <Button
        render={<Link href={`/space/${workspaceId}/contacts`} />}
        size="sm"
        variant="ghost"
      >
        <ArrowLeftIcon className="me-2 size-4" />
        {t("crm.backToContacts")}
      </Button>
      <CustomFieldStoreProvider workspaceId={workspaceId}>
        <ContactView contactId={contactId} workspaceId={workspaceId} />
      </CustomFieldStoreProvider>
    </div>
  )
}
