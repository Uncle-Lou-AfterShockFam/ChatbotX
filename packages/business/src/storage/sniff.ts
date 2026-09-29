import { imageSize } from "image-size"
import { isPdf } from "../documents/gotenberg"

/**
 * What a stored upload really is, judged by its magic bytes (s225a): never
 * the client's `Content-Type` or file name. `image-size`'s sniffed `type`
 * maps to the canonical MIME + a safe extension; anything it does not map
 * (svg, bmp, heif, ico, ...) is unknown, so an allowlist built on this
 * refuses it. A PDF needs both its header and its `%%EOF` trailer.
 */
export const SNIFFED_IMAGE_FORMAT = {
  jpg: { mimeType: "image/jpeg", extension: "jpg" },
  png: { mimeType: "image/png", extension: "png" },
  gif: { mimeType: "image/gif", extension: "gif" },
  webp: { mimeType: "image/webp", extension: "webp" },
} as const

export type SniffedUpload =
  | (typeof SNIFFED_IMAGE_FORMAT)[keyof typeof SNIFFED_IMAGE_FORMAT]
  | { mimeType: "application/pdf"; extension: "pdf" }

export function sniffUpload(bytes: Uint8Array): SniffedUpload | null {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    return null
  }
  if (isPdf(bytes)) {
    return { mimeType: "application/pdf", extension: "pdf" }
  }
  let type: string | undefined
  try {
    type = imageSize(bytes).type
  } catch {
    return null
  }
  return type !== undefined && Object.hasOwn(SNIFFED_IMAGE_FORMAT, type)
    ? SNIFFED_IMAGE_FORMAT[type as keyof typeof SNIFFED_IMAGE_FORMAT]
    : null
}
