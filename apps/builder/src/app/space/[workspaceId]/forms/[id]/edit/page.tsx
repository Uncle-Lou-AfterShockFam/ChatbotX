import { getIdFromParams } from "@chatbotx.io/utils"
import { notFound } from "next/navigation"
import { getTranslations } from "next-intl/server"
import { AppBreadcrumb } from "@/components/app-breadcrumb"
import { CustomFieldStoreProvider } from "@/features/custom-fields/provider/custom-field-store-context"
import { FormEditor } from "@/features/forms/components/form-editor"
import { requireContactsAccess } from "@/lib/auth/require-workspace-permission"

/**
 * The form builder (s200). Mounts the custom-field store the inspector's
 * "map to" picker reads (the s199 documents crash: a picker without its
 * store throws at first render).
 */
export default async function EditFormPage(props: {
  params: Promise<{ workspaceId: string; id: string }>
}) {
  const params = await props.params
  const workspaceId = getIdFromParams(params, "workspaceId")
  const id = getIdFromParams(params, "id")
  if (!(workspaceId && id)) {
    return notFound()
  }
  await requireContactsAccess(workspaceId)
  const t = await getTranslations()

  return (
    <div className="flex flex-col gap-4 p-4">
      <AppBreadcrumb
        items={[
          { label: t("forms.title"), href: `/space/${workspaceId}/forms` },
          { label: t("actions.edit"), href: "" },
        ]}
      />
      <CustomFieldStoreProvider workspaceId={workspaceId}>
        <FormEditor id={id} workspaceId={workspaceId} />
      </CustomFieldStoreProvider>
    </div>
  )
}
