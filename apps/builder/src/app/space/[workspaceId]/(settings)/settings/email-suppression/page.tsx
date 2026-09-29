import { getIdFromParams } from "@chatbotx.io/utils"
import { notFound } from "next/navigation"
import { EmailSuppressionSettings } from "@/features/email-suppression/components/email-suppression-settings"
import { requireContactsAccess } from "@/lib/auth/require-workspace-permission"

export default async function EmailSuppressionSettingsPage(props: {
  params: Promise<{ workspaceId: string }>
}) {
  const workspaceId = getIdFromParams(await props.params, "workspaceId")
  if (!workspaceId) {
    return notFound()
  }
  await requireContactsAccess(workspaceId)
  return <EmailSuppressionSettings workspaceId={workspaceId} />
}
