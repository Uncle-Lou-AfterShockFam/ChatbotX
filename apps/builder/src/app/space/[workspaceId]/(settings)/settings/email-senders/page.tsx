import { platformCredentialService } from "@chatbotx.io/business"
import { getIdFromParams } from "@chatbotx.io/utils"
import { notFound } from "next/navigation"
import { EmailSenderSettings } from "@/features/email-senders/components/email-sender-settings"
import { parseEmailSenderConnectOutcome } from "@/features/email-senders/lib"
import { requireWorkspacePermission } from "@/lib/auth/require-workspace-permission"
import { getCurrentUser } from "@/lib/auth/utils"
import { resolvePlatformOwnerId } from "@/lib/platform-credential-owner"

export default async function EmailSendersSettingsPage(props: {
  params: Promise<{ workspaceId: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const workspaceId = getIdFromParams(await props.params, "workspaceId")
  if (!workspaceId) {
    return notFound()
  }
  await requireWorkspacePermission(workspaceId, "superAdmin")
  const user = await getCurrentUser()
  if (!user) {
    return notFound()
  }
  // Only the PUBLIC Client ID reaches the page (the connect dialog shows it
  // for a Workspace admin to trust); the secret stays in the credential.
  const google = await platformCredentialService.resolveForOwner({
    ownerId: await resolvePlatformOwnerId({ userId: user.id, workspaceId }),
    type: "google",
  })
  const { emailSenderConnect } = await props.searchParams
  return (
    <EmailSenderSettings
      googleClientId={google?.config.clientId || null}
      outcome={parseEmailSenderConnectOutcome(emailSenderConnect)}
      workspaceId={workspaceId}
    />
  )
}
