import { getIdFromParams } from "@chatbotx.io/utils"
import { notFound } from "next/navigation"
import { getTranslations } from "next-intl/server"
import { AppBreadcrumb } from "@/components/app-breadcrumb"
import { CustomFieldStoreProvider } from "@/features/custom-fields/provider/custom-field-store-context"
import { buildDynamicImageTriggerUrl } from "@/features/dynamic-images/lib/dynamic-image-url"
import { findDynamicImage } from "@/features/dynamic-images/queries"
import { UpdateDynamicImageForm } from "@/features/dynamic-images/update-dynamic-image-form"

export default async function EditDynamicImagePage({
  params,
}: {
  params: Promise<{ workspaceId: string; id: string }>
}) {
  const resolvedParams = await params
  const workspaceId = getIdFromParams(resolvedParams, "workspaceId")
  const id = getIdFromParams(resolvedParams, "id")

  if (!(workspaceId && id)) {
    return notFound()
  }

  const dynamicImage = await findDynamicImage({ workspaceId, id })
  if (!dynamicImage) {
    return notFound()
  }

  const t = await getTranslations()

  const publicUrl = buildDynamicImageTriggerUrl(dynamicImage.id)

  return (
    <div className="flex flex-col gap-4">
      <AppBreadcrumb
        items={[
          {
            label: t("tools.title"),
            href: `/space/${workspaceId}/tools`,
          },
          {
            label: t("dynamicImages.title"),
            href: `/space/${workspaceId}/dynamic-images`,
          },
          { label: t("actions.edit"), href: "" },
        ]}
      />
      <CustomFieldStoreProvider workspaceId={workspaceId}>
        <UpdateDynamicImageForm
          dynamicImage={dynamicImage}
          publicUrl={publicUrl}
          workspaceId={workspaceId}
        />
      </CustomFieldStoreProvider>
    </div>
  )
}
