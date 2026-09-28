import { platformCredentialService } from "@chatbotx.io/business"
import { integrationQuickbooksService } from "@chatbotx.io/business/integration-quickbooks"
import { getIdFromParams } from "@chatbotx.io/utils"
import { notFound } from "next/navigation"
import { ManageQuickbooks } from "@/features/integration-quickbooks/components/manage-quickbooks"

const OUTCOMES = new Set(["connected", "conflict", "failed", "cancelled"])

export default async function SettingIntegrationQuickbooksPage(props: {
  params: Promise<{ workspaceId: string }>
  searchParams: Promise<{ quickbooks?: string | string[] }>
}) {
  const workspaceId = getIdFromParams(await props.params, "workspaceId")
  if (!workspaceId) {
    return notFound()
  }
  const { quickbooks: outcome } = await props.searchParams
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
      outcome={
        typeof outcome === "string" && OUTCOMES.has(outcome)
          ? (outcome as "connected" | "conflict" | "failed" | "cancelled")
          : null
      }
      workspaceId={workspaceId}
    />
  )
}
