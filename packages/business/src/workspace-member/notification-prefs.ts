import type {
  NotificationType,
  WorkspaceMemberNotificationChannels,
  WorkspaceMemberNotificationTypes,
} from "@chatbotx.io/database/partials"

export type ResolvedNotificationPrefs = {
  types: Required<WorkspaceMemberNotificationTypes>
  channels: Required<WorkspaceMemberNotificationChannels>
}

/** The deal keys added in s194: absent on every row written before. */
export const NEW_NOTIFICATION_TYPE_KEYS = [
  "taskAssigned",
  "dealMentioned",
] as const satisfies readonly NotificationType[]
export const NEW_NOTIFICATION_CHANNEL_KEYS = ["push", "inApp"] as const

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

const bool = (v: unknown, fallback: boolean): boolean =>
  typeof v === "boolean" ? v : fallback

/**
 * Normalising read of a member's stored preferences. Both jsonb columns
 * default to `{}` and older rows hold only the four original keys, so every
 * reader goes through here (hotfix-#27 rule: a new settings key needs a
 * normalising read path). The ORIGINAL keys default to false, which is what
 * their absence meant before (nothing read them); the s194 deal keys default
 * to TRUE so an existing member keeps receiving without visiting the form.
 * A null / non-object column is treated like `{}`.
 */
export const resolveMemberNotificationPrefs = (
  member:
    | {
        notificationTypes?: unknown
        notificationChannels?: unknown
      }
    | null
    | undefined,
): ResolvedNotificationPrefs => {
  const types = isObject(member?.notificationTypes)
    ? member.notificationTypes
    : {}
  const channels = isObject(member?.notificationChannels)
    ? member.notificationChannels
    : {}
  return {
    types: {
      notifyAdmin: bool(types.notifyAdmin, false),
      newMessageToHuman: bool(types.newMessageToHuman, false),
      newOrder: bool(types.newOrder, false),
      taskAssigned: bool(types.taskAssigned, true),
      dealMentioned: bool(types.dealMentioned, true),
    },
    channels: {
      messenger: bool(channels.messenger, false),
      email: bool(channels.email, false),
      telegram: bool(channels.telegram, false),
      browser: bool(channels.browser, false),
      push: bool(channels.push, true),
      inApp: bool(channels.inApp, true),
    },
  }
}
