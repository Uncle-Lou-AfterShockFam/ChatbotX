import { platformCredentialService } from "@chatbotx.io/business"
import { integrationQuickbooksService } from "@chatbotx.io/business/integration-quickbooks"
import { getIdFromParams } from "@chatbotx.io/utils"
import { notFound } from "next/navigation"
import { ManageQuickbooks } from "@/features/integration-quickbooks/components/manage-quickbooks"

export default async function SettingIntegrationQuickbooksPage(props: {
  params: Promise<{ workspaceId: string }>
}) {
  const workspaceId = getIdFromParams(await props.params, "workspaceId")
  if (!workspaceId) {
    return notFound()
  }
  const [summary, app] = await Promise.all([
    integrationQuickbooksService.summary(workspaceId),
    platformCredentialService.findPlatform({ type: "quickbooks" }),
  ])
  return (
    <ManageQuickbooks
      appConfigured={!!app}
      company={
        summary
          ? {
              companyName: summary.companyName,
              realmId: summary.realmId,
              homeCurrency: summary.homeCurrency,
              environment: summary.environment,
              mirrorEnabled: summary.mirrorEnabled,
              tokenRefreshError: summary.tokenRefreshError,
            }
          : null
      }
      workspaceId={workspaceId}
    />
  )
}
