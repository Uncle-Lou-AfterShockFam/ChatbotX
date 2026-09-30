import { getIdFromParams } from "@chatbotx.io/utils"
import { notFound } from "next/navigation"
import { EmailSenderSettings } from "@/features/email-senders/components/email-sender-settings"
import { requireContactsAccess } from "@/lib/auth/require-workspace-permission"

export default async function EmailSendersSettingsPage(props: {
  params: Promise<{ workspaceId: string }>
}) {
  const workspaceId = getIdFromParams(await props.params, "workspaceId")
  if (!workspaceId) {
    return notFound()
  }
  await requireContactsAccess(workspaceId)
  return <EmailSenderSettings workspaceId={workspaceId} />
}
