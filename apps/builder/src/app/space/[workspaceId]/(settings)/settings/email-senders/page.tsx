import { getIdFromParams } from "@chatbotx.io/utils"
import { notFound } from "next/navigation"
import { EmailSenderSettings } from "@/features/email-senders/components/email-sender-settings"
import { requireWorkspacePermission } from "@/lib/auth/require-workspace-permission"

export default async function EmailSendersSettingsPage(props: {
  params: Promise<{ workspaceId: string }>
}) {
  const workspaceId = getIdFromParams(await props.params, "workspaceId")
  if (!workspaceId) {
    return notFound()
  }
  await requireWorkspacePermission(workspaceId, "superAdmin")
  return <EmailSenderSettings workspaceId={workspaceId} />
}
