import { differenceInDays } from "date-fns"

type DateInput = Date | string | number | null | undefined

/**
 * Zone rule for every formatter below (s212): a CALENDAR DAY (a `YYYY-MM-DD`
 * bucket key, or a day built by date-fns in the local zone) is formatted in
 * the zone it was built in, so `timeZone` is omitted. An INSTANT (an
 * `occurredAt`) is formatted in the viewer's zone: pass next-intl's
 * `useTimeZone()`, which the server render and hydration share.
 */

const DATE_ONLY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/

function toValidDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === "") {
    return null
  }

  if (typeof value === "string") {
    // A bucket key (`YYYY-MM-DD`) is a calendar day the SERVER already resolved
    // in the viewer's timezone, so it must be read as a local day. `new Date()`
    // parses it as UTC midnight instead, which renders as the previous day —
    // and, for a monthly bucket (`YYYY-MM-01`), as the previous MONTH — west of
    // Greenwich.
    const parts = DATE_ONLY_KEY.exec(value)
    if (parts) {
      return new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]))
    }
  }

  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

export function formatShortDate(
  value: DateInput,
  locale: string,
  timeZone?: string,
): string {
  const date = toValidDate(value)
  if (!date) {
    return ""
  }

  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    timeZone,
  }).format(date)
}

export function formatDateWithYear(
  value: DateInput,
  locale: string,
  timeZone?: string,
): string {
  const date = toValidDate(value)
  if (!date) {
    return ""
  }

  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone,
  }).format(date)
}

/** Mirrors `resolveRangeGranularity` in `@chatbotx.io/analytics`: past 60 days
 * a series is bucketed by month, so its labels must name months, not days. */
function isMonthlyRange(fromValue: DateInput, toValue: DateInput): boolean {
  const from = toValidDate(fromValue)
  const to = toValidDate(toValue)
  return !!from && !!to && differenceInDays(to, from) > 60
}

export function formatTimeRangeDate(
  value: DateInput,
  fromValue: DateInput,
  toValue: DateInput,
  locale: string,
  timeZone?: string,
): string {
  const date = toValidDate(value)
  if (!date) {
    return ""
  }

  if (isMonthlyRange(fromValue, toValue)) {
    return new Intl.DateTimeFormat(locale, {
      month: "short",
      year: "numeric",
      timeZone,
    }).format(date)
  }

  return formatShortDate(date, locale, timeZone)
}

/**
 * `formatTimeRangeDate` for a table cell, which always names the year — a
 * dashboard whose range is now unbounded can list days from several years in
 * one series.
 */
export function formatTimeRangeDateWithYear(
  value: DateInput,
  fromValue: DateInput,
  toValue: DateInput,
  locale: string,
  timeZone?: string,
): string {
  const date = toValidDate(value)
  if (!date) {
    return ""
  }

  if (isMonthlyRange(fromValue, toValue)) {
    return new Intl.DateTimeFormat(locale, {
      month: "short",
      year: "numeric",
      timeZone,
    }).format(date)
  }

  return formatDateWithYear(date, locale, timeZone)
}
