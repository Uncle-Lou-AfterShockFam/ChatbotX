import { DYNAMIC_IMAGE_ROUTE_PATH } from "@chatbotx.io/business/dynamic-image/signed-link"
import { getBrokerOrigin } from "@/lib/oauth-broker"

/**
 * The trigger URL an operator pastes into an image step. It carries no
 * contact: the worker appends a signed per-contact `t` token at send time
 * (s214); the link as pasted serves the static background.
 */
export const buildDynamicImageTriggerUrl = (dynamicImageId: string): string =>
  `${getBrokerOrigin()}${DYNAMIC_IMAGE_ROUTE_PATH}?dynamicImageId=${dynamicImageId}`

export const extractDynamicImageId = (
  url: string | undefined,
): string | null => {
  if (!url) {
    return null
  }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }

  if (parsed.origin !== getBrokerOrigin()) {
    return null
  }

  if (parsed.pathname !== DYNAMIC_IMAGE_ROUTE_PATH) {
    return null
  }

  return parsed.searchParams.get("dynamicImageId")
}
