import { getCalendarClient } from "../client"
import { handleError } from "../error"
import type {
  GoogleCalendarAuthValue,
  GoogleCalendarListEntry,
} from "../schemas"

/** Hard cap on the calendars one account contributes to free/busy. */
export const CALENDAR_LIST_MAX = 250

/** Access roles that let us read free/busy for a calendar. */
export const BUSY_ACCESS_ROLES = new Set([
  "owner",
  "writer",
  "reader",
  "freeBusyReader",
])

/**
 * Every calendar visible in the connected account's calendar list (owned,
 * shared and subscribed), skipping deleted entries and roles that cannot
 * read free/busy. Needs only `calendar.readonly`, which the OAuth scope set
 * already carries, so no reconsent is required.
 */
export async function listCalendars({
  auth,
  timeoutMs,
}: {
  auth: GoogleCalendarAuthValue
  timeoutMs?: number
}): Promise<GoogleCalendarListEntry[]> {
  try {
    const calendarClient = getCalendarClient(auth)
    const entries: GoogleCalendarListEntry[] = []
    let pageToken: string | undefined
    do {
      const response = await calendarClient.calendarList.list(
        {
          maxResults: CALENDAR_LIST_MAX,
          minAccessRole: "freeBusyReader",
          pageToken,
        },
        timeoutMs ? { timeout: timeoutMs } : undefined,
      )
      for (const item of response.data.items ?? []) {
        if (!item.id || item.deleted) {
          continue
        }
        if (item.accessRole && !BUSY_ACCESS_ROLES.has(item.accessRole)) {
          continue
        }
        entries.push({
          id: item.id,
          summary: item.summary ?? null,
          primary: item.primary === true,
          accessRole: item.accessRole ?? null,
        })
        if (entries.length >= CALENDAR_LIST_MAX) {
          return entries
        }
      }
      pageToken = response.data.nextPageToken ?? undefined
    } while (pageToken)

    return entries
  } catch (error) {
    return handleError(error, "listCalendars")
  }
}
