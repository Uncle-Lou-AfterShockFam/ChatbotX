import { PrefixPurgeError, uploader } from "@chatbotx.io/filesystem"
import { logger } from "../logger"

/**
 * Best-effort removal of every object under `prefix`: a row delete that just
 * committed (contact, workspace, dynamic image) must never fail or roll back
 * because storage is unreachable, so every storage error is logged and
 * swallowed. The objects are orphaned and harmless on failure. A PARTIAL
 * purge (some objects gone, the rest not: the page cap, or one key failing
 * mid-page) is logged at `error` level with the count, so it is never
 * mistaken for a transient blip. A bad prefix (empty, wrong type) is a
 * caller bug and IS rethrown, because "delete nothing" and "delete the whole
 * bucket" both hide behind it.
 */
export async function purgeStoragePrefix(
  prefix: string,
  context: Record<string, unknown>,
  label: string,
  options: { except?: string } = {},
): Promise<number> {
  if (typeof prefix !== "string" || prefix.length === 0) {
    throw new TypeError(`${label}: prefix must be a non-empty string`)
  }
  try {
    const { deleted } = await uploader.deleteByPrefix(prefix, options)
    return deleted
  } catch (error) {
    const deleted = error instanceof PrefixPurgeError ? error.deleted : 0
    if (deleted > 0) {
      logger.error(
        { ...context, prefix, deleted, err: error },
        `${label}: storage purge stopped early, objects remain under prefix`,
      )
    } else {
      logger.warn(
        { ...context, prefix, err: error },
        `${label}: failed to purge storage objects under prefix`,
      )
    }
    return deleted
  }
}
