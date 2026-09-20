import { SdkException } from "@chatbotx.io/sdk"
import { z } from "zod"
import { getCalendarClient } from "../client"
import { handleError } from "../error"
import { googleCalendarLogger } from "../logger"
import type {
  GoogleCalendarAuthValue,
  GoogleCalendarBusyEvent,
} from "../schemas"

/** Google rejects a freebusy query naming more than 50 calendars. */
export const FREE_BUSY_MAX_ITEMS = 50

const freeBusyCalendarSchema = z.object({
  busy: z
    .array(
      z.object({
        start: z.string(),
        end: z.string(),
      }),
    )
    .optional(),
  errors: z
    .array(
      z.object({
        domain: z.string().optional(),
        reason: z.string().optional(),
      }),
    )
    .optional(),
})
type FreeBusyCalendar = z.infer<typeof freeBusyCalendarSchema>

const freeBusyResponseSchema = z.object({
  calendars: z.record(z.string(), freeBusyCalendarSchema).optional(),
})

/** The connected calendar plus any extra ids, trimmed, de-duplicated, in order. */
export function resolveBusyCalendarIds(input: {
  calendarId?: string
  calendarIds?: string[]
}): string[] {
  const seen = new Set<string>()
  const ids: string[] = []
  for (const raw of [input.calendarId ?? "", ...(input.calendarIds ?? [])]) {
    const id = raw.trim()
    if (id === "" || seen.has(id)) {
      continue
    }
    seen.add(id)
    ids.push(id)
  }
  return ids
}

export function chunkCalendarIds(
  ids: string[],
  size = FREE_BUSY_MAX_ITEMS,
): string[][] {
  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += size) {
    chunks.push(ids.slice(i, i + size))
  }
  return chunks
}

/**
 * Busy intervals across one or more calendars of the connected account.
 * `calendarId` is the connected calendar (always queried); `calendarIds`
 * adds the rest of the account when the connection's busy scope is `all`.
 * A calendar Google reports an error for (or omits) is logged and skipped;
 * only when EVERY calendar fails does the call throw, so one broken
 * subscription cannot silently open the whole schedule.
 */
export async function getBusyEvents({
  auth,
  calendarId,
  calendarIds,
  timeMin,
  timeMax,
  timeZone,
  timeoutMs,
}: {
  auth: GoogleCalendarAuthValue
  calendarId: string
  calendarIds?: string[]
  timeMin: string
  timeMax: string
  timeZone?: string
  timeoutMs?: number
}): Promise<GoogleCalendarBusyEvent[]> {
  try {
    const ids = resolveBusyCalendarIds({ calendarId, calendarIds })
    if (ids.length === 0) {
      throw new SdkException("getBusyEvents: no calendar id to query")
    }
    const calendarClient = getCalendarClient(auth)
    const busy: GoogleCalendarBusyEvent[] = []
    const failed: { id: string; reason: string }[] = []

    const responses = await Promise.all(
      chunkCalendarIds(ids).map((chunk) =>
        calendarClient.freebusy.query(
          {
            requestBody: {
              timeMin,
              timeMax,
              timeZone,
              items: chunk.map((id) => ({ id })),
            },
          },
          timeoutMs ? { timeout: timeoutMs } : undefined,
        ),
      ),
    )

    const calendars: Record<string, FreeBusyCalendar> = {}
    for (const response of responses) {
      Object.assign(
        calendars,
        freeBusyResponseSchema.parse(response.data).calendars ?? {},
      )
    }

    for (const id of ids) {
      const entry = calendars[id]
      if (!entry) {
        failed.push({ id, reason: "missing" })
        continue
      }
      if (entry.errors && entry.errors.length > 0) {
        failed.push({
          id,
          reason: entry.errors.map((e) => e.reason ?? "unknown").join(","),
        })
        continue
      }
      for (const event of entry.busy ?? []) {
        busy.push({ startAt: event.start, endAt: event.end })
      }
    }

    if (failed.length > 0) {
      if (failed.length === ids.length) {
        throw new SdkException(
          `getBusyEvents: free/busy failed for every calendar (${failed
            .map((f) => `${f.id}: ${f.reason}`)
            .join("; ")})`,
        )
      }
      googleCalendarLogger.warn(
        { failed, queried: ids.length },
        "Google free/busy skipped calendars that returned errors",
      )
    }

    return busy.sort((a, b) => a.startAt.localeCompare(b.startAt))
  } catch (error) {
    return handleError(error, "getBusyEvents")
  }
}
