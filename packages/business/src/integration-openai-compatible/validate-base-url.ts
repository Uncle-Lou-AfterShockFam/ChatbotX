import { ChatbotXException } from "../errors"
import { isCloud } from "../keys"
import { assertPublicUrl } from "../net"

const MAX_BASE_URL_LENGTH = 2048
const INVALID_BASE_URL_ERROR = "OpenAI-compatible base URL is invalid."
const BLOCKED_BASE_URL_ERROR = "OpenAI-compatible base URL is not allowed."

export const normalizeOpenaiCompatibleBaseUrl = (baseURL: string): string => {
  const trimmed = baseURL.trim()
  if (!trimmed || trimmed.length > MAX_BASE_URL_LENGTH) {
    throw new ChatbotXException(INVALID_BASE_URL_ERROR, "invalidBaseUrl", 400)
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new ChatbotXException(INVALID_BASE_URL_ERROR, "invalidBaseUrl", 400)
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ChatbotXException(INVALID_BASE_URL_ERROR, "invalidBaseUrl", 400)
  }

  return parsed.toString()
}

const TRAILING_SLASHES = /\/+$/

const comparable = (url: string) =>
  new URL(url).href.replace(TRAILING_SLASHES, "")

/**
 * Same base URL after WHATWG normalisation, trailing slashes ignored; a
 * missing or unparsable side never matches (s233a). The stored API key may be
 * reused only when this holds, or it would be sent to a host the caller chose.
 */
export const isSameOpenaiCompatibleBaseUrl = (
  a: string | null | undefined,
  b: string | null | undefined,
): boolean => {
  if (!(a && b)) {
    return false
  }
  try {
    return comparable(a) === comparable(b)
  } catch {
    return false
  }
}

export const validateOpenaiCompatibleBaseUrlForEnvironment = async (
  baseURL: string,
): Promise<string> => {
  const normalizedBaseUrl = normalizeOpenaiCompatibleBaseUrl(baseURL)

  if (!isCloud()) {
    return normalizedBaseUrl
  }

  try {
    await assertPublicUrl(normalizedBaseUrl, "OpenAI-compatible base URL")
  } catch {
    throw new ChatbotXException(BLOCKED_BASE_URL_ERROR, "ssrfBlocked", 400)
  }

  return normalizedBaseUrl
}
