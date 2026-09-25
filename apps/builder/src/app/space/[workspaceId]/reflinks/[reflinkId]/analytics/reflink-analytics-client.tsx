"use client"

import { ReflinkAnalytics } from "@chatbotx.io/analytics-nextjs/components/reflink-analytics"

export function ReflinkAnalyticsClient({
  workspaceId,
  linkId,
  linkName,
}: {
  workspaceId: string
  linkId: string
  linkName: string
}) {
  // zone: viewer (client component: the browser's zone buckets the chart)
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return (
    <ReflinkAnalytics
      defaultSearchParams={{ workspaceId, linkId, timezone, linkName }}
    />
  )
}
