import type { ObjectCannedACL } from "@aws-sdk/client-s3"
import { getChildLogger } from "@chatbotx.io/logger"
import { createId } from "@chatbotx.io/utils"
import { readBodyWithLimit } from "./bounded-fetch"
import { getImageDimensions, pathJoin } from "./helper"
import { DEFAULT_MIME_TYPE, type UploadedFile } from "./schema"
import { uploader } from "./uploader"

const logger = getChildLogger("filesystem:upload")

/**
 * Distinguishes a caller-fault upload failure (oversized body, unreachable
 * URL, too many redirects, SSRF rejection) from an infrastructure failure
 * (storage outage, network error) — callers like
 * `packages/business/src/ai-file/service.ts` need this to avoid surfacing
 * internal error text (e.g. "connect ECONNREFUSED ...") as a 400 to the
 * request's caller.
 */
export class UploadValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UploadValidationError"
  }
}

export async function uploadFile(
  file: File,
  path: string,
  acl = "public-read",
): Promise<UploadedFile> {
  const buffer = (await file.arrayBuffer()) as unknown as Buffer
  await uploader.putObject(path, buffer, {
    ACL: acl as ObjectCannedACL,
    ContentLength: file.size,
    ContentType: file.type,
  })

  const imageDimensions = await getImageDimensions(file.type, buffer)

  return {
    name: file.name,
    originPath: path,
    size: file.size,
    ...imageDimensions,
  }
}

export async function uploadMultipleFiles(
  files: File[],
  prefix: string,
  acl = "public-read",
): Promise<UploadedFile[]> {
  return await Promise.all(
    files.map((file) => uploadFile(file, pathJoin(prefix, createId()), acl)),
  )
}

/** Default cap on a URL download when the caller names none (s216). */
export const DEFAULT_MAX_URL_DOWNLOAD_BYTES = 100 * 1024 * 1024

export type UploadFromUrlOptions = {
  acl?: string
  maxBytes?: number
  /**
   * The SSRF-pinned fetch (`outboundDownload` from @chatbotx.io/business):
   * it follows and re-checks redirects itself. There is deliberately no
   * default: a plain `fetch` here stored any internal URL's body public-read
   * (s216).
   */
  fetchImpl: (url: string) => Promise<Response>
}

/** The pinned fetch refused the URL: the caller's input, not an outage. */
const isSsrfRefusal = (error: unknown): boolean =>
  error instanceof Error && error.name === "SsrfFetchError"

export async function uploadFileFromUrl(
  url: string,
  path: string,
  options: UploadFromUrlOptions,
): Promise<UploadedFile> {
  const {
    acl = "public-read",
    maxBytes = DEFAULT_MAX_URL_DOWNLOAD_BYTES,
    fetchImpl,
  } = options
  let response: Response
  try {
    response = await fetchImpl(url)
  } catch (error) {
    if (isSsrfRefusal(error)) {
      throw new UploadValidationError("The provided URL is not allowed")
    }
    throw error
  }
  const finalUrl = response.url || url
  if (!response.ok) {
    throw new UploadValidationError(
      `Failed to download file: ${response.status}`,
    )
  }

  const mimeType = (response.headers.get("content-type") || DEFAULT_MIME_TYPE)
    .split(";")[0]
    .trim()
  const headerLength = Number.parseInt(
    response.headers.get("content-length") ?? "0",
    10,
  )
  if (headerLength > maxBytes) {
    throw new UploadValidationError(
      `File exceeds the maximum allowed size of ${maxBytes} bytes`,
    )
  }

  let name = createId()
  try {
    const u = new URL(finalUrl)
    const last = u.pathname.split("/").pop() ?? ""
    if (last) {
      name = decodeURIComponent(last)
    }
  } catch (error) {
    logger.warn({ err: error }, "uploadFileFromUrl: invalid URL")
  }

  const buffer = await readBodyWithLimit(
    response,
    maxBytes,
    (limit) =>
      new UploadValidationError(
        `File exceeds the maximum allowed size of ${limit} bytes`,
      ),
  )
  // headerLength is the origin's self-reported content-length, used only as
  // an early-reject hint above — it can disagree with what was actually
  // streamed, and putObject's ContentLength must match the real buffer.
  const size = buffer.byteLength

  await uploader.putObject(path, buffer, {
    ACL: acl as ObjectCannedACL,
    ContentType: mimeType,
    ContentLength: size,
  })

  const imageDimensions = await getImageDimensions(mimeType, buffer)

  return {
    name,
    originPath: path,
    size,
    ...imageDimensions,
  }
}
