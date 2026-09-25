import { getIdFromParams } from "@chatbotx.io/utils"
import { notFound } from "next/navigation"
import { getTranslations } from "next-intl/server"
import { AppBreadcrumb } from "@/components/app-breadcrumb"
import { FormSubmissions } from "@/features/forms/components/form-submissions"
import { requireContactsAccess } from "@/lib/auth/require-workspace-permission"

/** A form's submissions (s200). */
export default async function FormSubmissionsPage(props: {
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
          { label: t("forms.submissions.title"), href: "" },
        ]}
      />
      <FormSubmissions id={id} workspaceId={workspaceId} />
    </div>
  )
}
