import { ContactsDashboard } from "@chatbotx.io/analytics-nextjs/components/contacts-dashboard"
import { getIdFromParams } from "@chatbotx.io/utils"
import { notFound } from "next/navigation"
import { getTimeZone } from "next-intl/server"
import { AnalyticsNav } from "@/features/analytics/components/analytics-nav"
import { resolveAdsDashboardChannels } from "@/features/analytics/lib/ads-dashboard-channels"
import { hasWorkspacePermission } from "@/lib/auth/permission-routes"
import { getCurrentUserAndTargetWorkspace } from "@/lib/auth/utils"

export default async function ContactsAnalyticsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>
}) {
  const workspaceId = getIdFromParams(await params, "workspaceId")
  if (!workspaceId) {
    return notFound()
  }

  const userAndWorkspace = await getCurrentUserAndTargetWorkspace(workspaceId)
  if (
    !(
      userAndWorkspace &&
      hasWorkspacePermission(
        userAndWorkspace.targetWorkspaceMember.permissions,
        "analytics",
      )
    )
  ) {
    return notFound()
  }

  // The user's zone (next-intl's), not the runtime's: this is a server
  // component, where the Intl probe answers the container's UTC.
  const timezone = await getTimeZone()
  const { targetWorkspace } = userAndWorkspace
  const isSuperAdmin = hasWorkspacePermission(
    userAndWorkspace.targetWorkspaceMember.permissions,
    "superAdmin",
  )
  const adsChannels = await resolveAdsDashboardChannels({
    workspaceId,
    isSuperAdmin,
  })

  return (
    <ContactsDashboard
      defaultSearchParams={{ workspaceId, timezone }}
      nav={<AnalyticsNav adsChannels={adsChannels} />}
      workspaceCreatedAt={targetWorkspace.createdAt}
    />
  )
}
