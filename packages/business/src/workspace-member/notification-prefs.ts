import type {
  WorkspaceMemberNotificationChannels,
  WorkspaceMemberNotificationTypes,
} from "@chatbotx.io/database/partials"

export type ResolvedNotificationPrefs = {
  types: Required<WorkspaceMemberNotificationTypes>
  channels: Required<WorkspaceMemberNotificationChannels>
}

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

/**
 * The preferences a member may change for THEMSELVES (s198): only the keys a
 * delivery path reads today (`notificationService.notify`); the legacy keys
 * stay admin-only in Settings > Admins.
 */
export type OwnNotificationPrefs = {
  types: { taskAssigned: boolean; dealMentioned: boolean }
  channels: { inApp: boolean; push: boolean }
}
export type OwnNotificationPrefsPatch = {
  types?: Partial<OwnNotificationPrefs["types"]>
  channels?: Partial<OwnNotificationPrefs["channels"]>
}

const OWN_KEYS = {
  types: ["taskAssigned", "dealMentioned"],
  channels: ["inApp", "push"],
} as const

export const ownNotificationPrefs = (
  member: Parameters<typeof resolveMemberNotificationPrefs>[0],
): OwnNotificationPrefs => {
  const { types, channels } = resolveMemberNotificationPrefs(member)
  return {
    types: {
      taskAssigned: types.taskAssigned,
      dealMentioned: types.dealMentioned,
    },
    channels: { inApp: channels.inApp, push: channels.push },
  }
}

/**
 * A closed self-service patch, or null: an unknown group or key (e.g. a
 * smuggled `permissions` or `notifyAdmin`), a non-boolean value, or nothing
 * to change.
 */
export const parseOwnNotificationPrefsPatch = (
  input: unknown,
): OwnNotificationPrefsPatch | null => {
  if (!isObject(input)) {
    return null
  }
  const out: Record<string, Record<string, boolean>> = {}
  let changes = 0
  for (const [group, value] of Object.entries(input)) {
    if (!((group === "types" || group === "channels") && isObject(value))) {
      return null
    }
    const allowed: readonly string[] = OWN_KEYS[group]
    const picked: Record<string, boolean> = {}
    for (const [key, flag] of Object.entries(value)) {
      if (!allowed.includes(key) || typeof flag !== "boolean") {
        return null
      }
      picked[key] = flag
      changes++
    }
    out[group] = picked
  }
  return changes > 0 ? (out as OwnNotificationPrefsPatch) : null
}
