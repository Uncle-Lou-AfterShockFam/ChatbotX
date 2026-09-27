import { getDefaultAdsAnalyticsRange } from "@chatbotx.io/business/ads-analytics/date-range"
import {
  createSearchParamsCache,
  parseAsString,
  type SearchParams,
} from "nuqs/server"
import { accountSearchParam } from "./account"

export {
  getDefaultAdsAnalyticsRange,
  MAX_ADS_ANALYTICS_RANGE_DAYS,
  parseAnalyticsDateRange,
  toDateKey,
} from "@chatbotx.io/business/ads-analytics/date-range"

const adsAnalyticsSearchParamsCache = createSearchParamsCache({
  account: accountSearchParam,
  // `channelAccount` narrows to one messenger/instagram integration for the
  // selected channel — mirrors `account`'s role for whatsapp, but omitted
  // (default "") aggregates across every connected integration for that
  // channel instead of forcing a single selection. The channel itself is the
  // route segment (`/dashboard/ads/<channel>`), never a search param.
  channelAccount: parseAsString.withDefault(""),
  adAccount: parseAsString.withDefault(""),
  // No default here: a module-level default would freeze "today" at server
  // start. `parseAdsAnalyticsSearchParams` fills it per request (s214).
  from: parseAsString,
  to: parseAsString,
  // Carries the viewer's IANA timezone name (e.g. `Intl.DateTimeFormat().
  // resolvedOptions().timeZone`, threaded from the client — a server
  // component can't read the browser's timezone). Default "" resolves to
  // "UTC" in `resolveTimezone`/`parseAnalyticsDateRange`, so a request that
  // never carried `tz` (an old bookmark, an external/legacy caller) keeps
  // the pre-migration UTC-anchored behavior byte-identical.
  tz: parseAsString.withDefault(""),
})

/**
 * Parses the ads dashboard's search params, defaulting a missing `from`/`to`
 * to the last seven days as calendar days in the viewer's zone: the `tz`
 * param, else `requestTimeZone` (the zone cookie), else UTC.
 */
export async function parseAdsAnalyticsSearchParams(
  searchParams: SearchParams | Promise<SearchParams>,
  options: { requestTimeZone?: string; now?: Date } = {},
) {
  const search = adsAnalyticsSearchParamsCache.parse(await searchParams)
  const fallback = getDefaultAdsAnalyticsRange(
    options.now,
    search.tz || options.requestTimeZone,
  )
  return {
    ...search,
    from: search.from ?? fallback.from,
    to: search.to ?? fallback.to,
  }
}

export type AdsAnalyticsSearchParams = Awaited<
  ReturnType<typeof parseAdsAnalyticsSearchParams>
>
