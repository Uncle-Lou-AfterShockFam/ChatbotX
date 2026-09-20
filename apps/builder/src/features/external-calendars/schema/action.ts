import { z } from "zod"

export const connectExternalCalendarRequest = z.object({
  referer: z.url(),
})
export type ConnectExternalCalendarRequest = z.infer<
  typeof connectExternalCalendarRequest
>

export const busyCalendarScopeRequest = z.enum(["connected", "all"])
export type BusyCalendarScopeRequest = z.infer<typeof busyCalendarScopeRequest>

export const updateExternalCalendarIdRequest = z.object({
  providerCalendarId: z.string().trim().min(1).max(255),
  busyCalendarScope: busyCalendarScopeRequest.default("connected"),
})
export type UpdateExternalCalendarIdRequest = z.infer<
  typeof updateExternalCalendarIdRequest
>
