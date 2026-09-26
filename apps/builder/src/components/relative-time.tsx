"use client"

import { formatDistance, formatDistanceStrict } from "date-fns"
import { useRenderNow } from "@/hooks/use-render-now"

/**
 * "5 minutes ago" against a hydration-safe clock (`useRenderNow`). date-fns
 * `formatDistanceToNow*` reads the clock during render, so the server and the
 * hydrating client can disagree; the zone gate rejects them in `src`.
 */
export function RelativeTime({
  date,
  strict = false,
  addSuffix = false,
}: {
  date: Parameters<typeof formatDistance>[0]
  strict?: boolean
  addSuffix?: boolean
}) {
  const now = useRenderNow()
  const format = strict ? formatDistanceStrict : formatDistance
  return <>{format(date, now, { addSuffix })}</>
}
