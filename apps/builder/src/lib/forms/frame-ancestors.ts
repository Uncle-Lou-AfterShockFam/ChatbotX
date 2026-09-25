import { formService } from "@chatbotx.io/business/form"
import { FORM_EMBED_ORIGIN_REGEX } from "@chatbotx.io/database/partials"
import { distributedStore } from "@chatbotx.io/redis"
import { logger } from "@/lib/log"

/**
 * `frame-ancestors` for a public form page (s200). Server components cannot
 * set response headers, so the proxy asks here; the allowlist is cached for
 * `CACHE_SECONDS`, so a changed setting takes up to that long to reach an
 * embedding page. `X-Frame-Options` is never set: it would override this.
 */
export const FORM_FRAME_ANCESTORS_CACHE_SECONDS = 60
const FORM_PATH =
  /^\/forms\/(\d{1,19})\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/?$/

/** Only well-formed origins reach the header, wherever the list came from. */
export const sanitizeOrigins = (list: unknown): string[] =>
  Array.isArray(list)
    ? list.filter(
        (o): o is string =>
          typeof o === "string" && FORM_EMBED_ORIGIN_REGEX.test(o),
      )
    : []

export const buildFrameAncestors = (origins: unknown): string =>
  `frame-ancestors 'self'${sanitizeOrigins(origins)
    .map((o) => ` ${o}`)
    .join("")}`

/** The two store calls this needs; `distributedStore` satisfies it. */
export type FrameAncestorsCache = {
  get<T>(key: string): Promise<T | null>
  put(key: string, value: unknown, ttlInSeconds?: number): Promise<void>
}

export async function formFrameAncestors(
  pathname: string,
  deps: {
    load?: (workspaceId: string, slug: string) => Promise<string[] | null>
    cache?: FrameAncestorsCache
  } = {},
): Promise<string | null> {
  const match = FORM_PATH.exec(pathname)
  if (!match) {
    return null
  }
  const [, workspaceId, slug] = match
  const key = `form-frame-ancestors:${workspaceId}:${slug}`
  const cache = deps.cache ?? distributedStore
  const load =
    deps.load ??
    ((ws: string, s: string) =>
      formService.getEmbedOrigins({ workspaceId: ws, slug: s }))
  try {
    const cached = await cache.get<unknown>(key)
    if (Array.isArray(cached)) {
      return buildFrameAncestors(cached)
    }
  } catch (error) {
    logger.warn({ err: error }, "form frame-ancestors cache read failed")
  }
  let origins: string[] | null = null
  try {
    origins = await load(workspaceId, slug)
  } catch (error) {
    logger.warn(
      { err: error, workspaceId, slug },
      "form frame-ancestors load failed",
    )
  }
  // Unknown form: still deny framing by strangers (the page 404s anyway).
  const list = sanitizeOrigins(origins)
  try {
    await cache.put(key, list, FORM_FRAME_ANCESTORS_CACHE_SECONDS)
  } catch (error) {
    logger.warn({ err: error }, "form frame-ancestors cache write failed")
  }
  return buildFrameAncestors(list)
}
