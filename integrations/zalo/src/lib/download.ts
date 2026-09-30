import { outboundDownload, readCapped } from "@chatbotx.io/sdk/outbound-fetch"
import { ZaloException } from "./exception"

/**
 * Zalo's own upload ceiling is 5 MB (file) / 1 MB (image); anything past
 * 10 MB is never worth buffering in a worker.
 */
export const ZALO_DOWNLOAD_MAX_BYTES = 10 * 1024 * 1024

const HTTP_PAYLOAD_TOO_LARGE = 413

export class ZaloAttachmentTooLargeError extends ZaloException {
  constructor(what: string) {
    super(
      `Zalo ${what} is larger than ${ZALO_DOWNLOAD_MAX_BYTES} bytes`,
      HTTP_PAYLOAD_TOO_LARGE,
      "zaloAttachmentTooLarge",
    )
    this.name = "ZaloAttachmentTooLargeError"
  }
}

// Zalo's own domains (API, OAuth, media CDN). The OA access token goes only
// to these: an attachment or avatar URL arrives in a webhook body (unsigned
// today) or a profile answer, and a token sent to any other host is leaked.
const ZALO_TOKEN_HOST_SUFFIXES = ["zalo.me", "zaloapp.com", "zadn.vn", "zdn.vn"]

/** The download headers for `url`: the Bearer token only on an https Zalo host. */
export const zaloDownloadHeaders = (
  url: string,
  accessToken: string,
  userAgent: string,
): Record<string, string> => {
  const headers: Record<string, string> = { "User-Agent": userAgent }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return headers
  }
  const host = parsed.hostname.toLowerCase()
  const isZaloHost = ZALO_TOKEN_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  )
  if (parsed.protocol === "https:" && isZaloHost) {
    headers.Authorization = `Bearer ${accessToken}`
  }
  return headers
}

/**
 * GETs a flow- or webhook-supplied URL through the pinned outbound fetch
 * (private addresses refused at connect, one download deadline) and reads at
 * most ZALO_DOWNLOAD_MAX_BYTES. `null` = a non-2xx or empty answer (nothing
 * worth storing).
 */
export const fetchZaloDownload = async (
  url: string,
  headers: Record<string, string> | undefined,
  what: string,
): Promise<{ response: Response; bytes: Uint8Array } | null> => {
  const response = await outboundDownload(
    url,
    headers ? { headers } : undefined,
  )
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    return null
  }
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > ZALO_DOWNLOAD_MAX_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    throw new ZaloAttachmentTooLargeError(what)
  }
  const bytes = await readCapped(response, ZALO_DOWNLOAD_MAX_BYTES)
  if (bytes === null) {
    throw new ZaloAttachmentTooLargeError(what)
  }
  return bytes.byteLength > 0 ? { response, bytes } : null
}

/** `fetchZaloDownload` where a non-2xx answer is a ZaloException. */
export const readZaloDownload = async (
  url: string,
  headers: Record<string, string> | undefined,
  what: string,
): Promise<{ response: Response; bytes: Uint8Array }> => {
  const result = await fetchZaloDownload(url, headers, what)
  if (!result) {
    throw new ZaloException(`Failed to fetch ${what}`)
  }
  return result
}
