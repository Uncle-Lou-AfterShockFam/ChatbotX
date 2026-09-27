import {
  getHostFromOrigin,
  isFirstPartyOrigin,
  isOriginAuthorized,
} from "./authorized-domain"
import {
  createWebchatAccessToken,
  readWebchatAccessToken,
} from "./webchat-access-token"

/**
 * How long after expiry a token can still be traded in: a tab that slept
 * through the 30-minute TTL recovers without a reload, a day-old one reloads.
 */
export const WEBCHAT_TOKEN_REFRESH_GRACE_SECONDS = 24 * 60 * 60

export type RefreshWebchatTokenInput = {
  token: string | null | undefined
  workspaceId: string
  webchatId: string
  parentOrigin: string | null | undefined
  /** The proxy's `x-domain`; see isFirstPartyOrigin. */
  appHost: string
}

export type RefreshWebchatTokenDeps = {
  /** The webchat's allowlist, or null when the webchat does not exist. */
  loadAuthorizedDomains: (props: {
    workspaceId: string
    webchatId: string
  }) => Promise<string[] | null>
  /** False for a missing workspace or one scheduled for deletion. */
  isWorkspaceActive: (workspaceId: string) => Promise<boolean>
  nowSeconds?: () => number
}

/**
 * A fresh guest token for the same session (owner s210), or null. The old
 * token must be ours, for this webchat, presented from the host it was minted
 * for, and at most a day past expiry. The `/webchat` page's embed gate then
 * runs again on that host, so a site removed from the allowlist (or a
 * workspace being deleted) stops getting tokens: a refresh can never outlive
 * a gate that a page reload would fail.
 */
export async function refreshWebchatAccessToken(
  input: RefreshWebchatTokenInput,
  deps: RefreshWebchatTokenDeps,
): Promise<string | null> {
  const payload = await readWebchatAccessToken(input.token)
  if (!payload) {
    return null
  }
  const now = deps.nowSeconds?.() ?? Math.floor(Date.now() / 1000)
  if (
    payload.workspaceId !== input.workspaceId ||
    payload.webchatId !== input.webchatId ||
    payload.originHost !== getHostFromOrigin(input.parentOrigin) ||
    now - payload.exp > WEBCHAT_TOKEN_REFRESH_GRACE_SECONDS
  ) {
    return null
  }

  const [domains, workspaceActive] = await Promise.all([
    deps.loadAuthorizedDomains({
      workspaceId: payload.workspaceId,
      webchatId: payload.webchatId,
    }),
    deps.isWorkspaceActive(payload.workspaceId),
  ])
  if (!(domains && workspaceActive)) {
    return null
  }
  // The page's gate, on the host the token is bound to.
  if (
    !(
      isFirstPartyOrigin(payload.originHost, input.appHost) ||
      isOriginAuthorized(payload.originHost, domains)
    )
  ) {
    return null
  }

  return await createWebchatAccessToken({
    origin: payload.originHost,
    webchatId: payload.webchatId,
    workspaceId: payload.workspaceId,
  })
}
