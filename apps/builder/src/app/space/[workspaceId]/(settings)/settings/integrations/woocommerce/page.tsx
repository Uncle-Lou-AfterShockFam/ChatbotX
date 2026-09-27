import { integrationWooCommerceService } from "@chatbotx.io/business/integration-woocommerce"
import { getIdFromParams } from "@chatbotx.io/utils"
import { notFound } from "next/navigation"
import { ManageWooCommerce } from "@/features/integration-woocommerce/components/manage-woocommerce"

export default async function SettingIntegrationWooCommercePage(props: {
  params: Promise<{ workspaceId: string }>
}) {
  const workspaceId = getIdFromParams(await props.params, "workspaceId")
  if (!workspaceId) {
    return notFound()
  }
  const sites =
    await integrationWooCommerceService.listByWorkspaceId(workspaceId)
  return (
    <ManageWooCommerce
      sites={sites.map((site) => ({
        integrationId: site.integrationId,
        siteSlug: site.siteSlug,
        siteUrl: site.siteUrl,
        tokenLast4: site.tokenLast4,
        currency: site.currency,
      }))}
      workspaceId={workspaceId}
    />
  )
}
