"use client"

import { resolvePresetOption } from "@chatbotx.io/analytics-nextjs/components/date-range-preset-filter"
import { useHydrated } from "@/hooks/use-hydrated"

/**
 * The preset the filter should show for `range`. Which preset a range matches
 * depends on "today" in the process's zone, which differs between the server
 * (UTC) and the browser, so resolving it during SSR mismatched at hydration
 * (React #418). Until hydrated it is `"custom"`: the filter then shows the
 * range as dates, the same calendar days on both sides. Key the filter on
 * `hydrated` so it remounts with the resolved preset (s214).
 */
export function useAdsFilterPreset(
  range: { from: Date; to: Date },
  workspaceCreatedAt?: Date,
): { hydrated: boolean; preset: ReturnType<typeof resolvePresetOption> } {
  const hydrated = useHydrated()
  return {
    hydrated,
    preset: hydrated
      ? resolvePresetOption(range, workspaceCreatedAt)
      : "custom",
  }
}
