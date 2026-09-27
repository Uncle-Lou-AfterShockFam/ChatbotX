import { integrationWebchatService } from "@chatbotx.io/business"
import { distributedStore } from "@chatbotx.io/redis"
import type { FrameAncestorsCache } from "@/lib/forms/frame-ancestors"
import { logger } from "@/lib/log"
import { getHostFromOrigin } from "./authorized-domain"

/**
 * `frame-ancestors` for the `/webchat` iframe page (owner s210). The page gate
 * reads the Referer, so an embed with `referrerpolicy="no-referrer"` looked
 * like a direct open and skipped `authorizedDomains`; the browser enforces
 * this header whatever the Referer says. Same shape as the forms header: the
 * proxy asks, the allowlist is cached for `CACHE_SECONDS`, `X-Frame-Options`
 * is never set (it would override this). Top-level opens are unaffected.
 */
export const WEBCHAT_FRAME_ANCESTORS_CACHE_SECONDS = 60
const WEBCHAT_PATH = /^\/webchat\/?$/
const ID = /^\d{1,19}$/
const HOST_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
const HOST = new RegExp(`^(?:${HOST_LABEL}\\.)*${HOST_LABEL}$`)
const MAX_DOMAINS = 100

/**
 * The allowlist as CSP sources. It matches like `isOriginAuthorized`: the host
 * and its subdomains, on http or https. Anything that is not a plain host
 * (spaces, `;`, quotes, `*`) is dropped, so a stored value can never inject a
 * directive.
 */
export const webchatAncestorSources = (domains: unknown): string[] => {
  if (!Array.isArray(domains)) {
    return []
  }
  const hosts = new Set<string>()
  for (const domain of domains.slice(0, MAX_DOMAINS)) {
    const host = typeof domain === "string" ? getHostFromOrigin(domain) : null
    if (host && host.length <= 253 && HOST.test(host)) {
      hosts.add(host)
    }
  }
  return [...hosts].flatMap((host) => [
    `https://${host}`,
    `https://*.${host}`,
    `http://${host}`,
    `http://*.${host}`,
  ])
}

export const buildWebchatFrameAncestors = (domains: unknown): string =>
  `frame-ancestors 'self'${webchatAncestorSources(domains)
    .map((source) => ` ${source}`)
    .join("")}`

export async function webchatFrameAncestors(
  pathname: string,
  searchParams: URLSearchParams,
  deps: {
    load?: (workspaceId: string, webchatId: string) => Promise<unknown>
    cache?: FrameAncestorsCache
  } = {},
): Promise<string | null> {
  if (!WEBCHAT_PATH.test(pathname)) {
    return null
  }
  const workspaceId = searchParams.get("workspaceId") ?? ""
  const webchatId = searchParams.get("webchatId") ?? ""
  // Unknown or malformed ids: the page 404s, and strangers still may not frame it.
  if (!(ID.test(workspaceId) && ID.test(webchatId))) {
    return buildWebchatFrameAncestors([])
  }
  const key = `webchat-frame-ancestors:${workspaceId}:${webchatId}`
  const cache = deps.cache ?? distributedStore
  const load =
    deps.load ??
    (async (ws: string, id: string) =>
      (
        await integrationWebchatService.findByIdForWorkspaceOrNull({
          id,
          workspaceId: ws,
        })
      )?.authorizedDomains ?? [])
  try {
    const cached = await cache.get<unknown>(key)
    if (Array.isArray(cached)) {
      return buildWebchatFrameAncestors(cached)
    }
  } catch (error) {
    logger.warn({ err: error }, "webchat frame-ancestors cache read failed")
  }
  let domains: unknown = []
  try {
    domains = await load(workspaceId, webchatId)
  } catch (error) {
    // Fail closed: 'self' only, and nothing cached, so the next request retries.
    logger.warn(
      { err: error, workspaceId, webchatId },
      "webchat frame-ancestors load failed",
    )
    return buildWebchatFrameAncestors([])
  }
  const list = Array.isArray(domains)
    ? domains.filter((d): d is string => typeof d === "string")
    : []
  try {
    await cache.put(key, list, WEBCHAT_FRAME_ANCESTORS_CACHE_SECONDS)
  } catch (error) {
    logger.warn({ err: error }, "webchat frame-ancestors cache write failed")
  }
  return buildWebchatFrameAncestors(list)
}
