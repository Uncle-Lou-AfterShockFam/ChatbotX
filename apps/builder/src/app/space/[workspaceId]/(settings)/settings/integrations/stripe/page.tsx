import { integrationStripeService } from "@chatbotx.io/business/integration-stripe"
import { getIdFromParams } from "@chatbotx.io/utils"
import { notFound } from "next/navigation"
import { ManageStripe } from "@/features/integration-stripe/components/manage-stripe"

export default async function SettingIntegrationStripePage(props: {
  params: Promise<{ workspaceId: string }>
}) {
  const workspaceId = getIdFromParams(await props.params, "workspaceId")
  if (!workspaceId) {
    return notFound()
  }
  const connection =
    await integrationStripeService.findByWorkspaceId(workspaceId)
  return (
    <ManageStripe
      connection={
        connection && {
          accountId: connection.accountId,
          accountName: connection.accountName,
          livemode: connection.livemode,
          keyLast4: connection.keyLast4,
        }
      }
      workspaceId={workspaceId}
    />
  )
}
