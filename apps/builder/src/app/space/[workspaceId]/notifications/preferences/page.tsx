import { getIdFromParams } from "@chatbotx.io/utils"
import { notFound } from "next/navigation"
import { NotificationPreferences } from "@/features/notifications/components/notification-preferences"

/**
 * A member's own notification preferences (s198). Outside the superAdmin
 * settings layout on purpose: any member reaches it; the API scopes every
 * read and write to the caller's own member row.
 */
export default async function NotificationPreferencesPage(props: {
  params: Promise<{ workspaceId: string }>
}) {
  const workspaceId = getIdFromParams(await props.params, "workspaceId")
  if (!workspaceId) {
    return notFound()
  }

  return <NotificationPreferences workspaceId={workspaceId} />
}
