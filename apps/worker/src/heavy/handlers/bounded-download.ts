import {
  assertPublicUrl,
  DOWNLOAD_TIMEOUT_MS,
  isSsrfFetchError,
  outboundFetch,
} from "@chatbotx.io/business"
import {
  fetchFollowingSafeRedirects,
  readBodyWithLimit,
} from "@chatbotx.io/filesystem"
import { ExpectedHeavyStepError } from "./errors"

const MAX_REDIRECTS = 5
// ky's default response-header timeout, kept when the caller names none.
const DEFAULT_HEADER_TIMEOUT_MS = 10_000

/**
 * One hop through the pinned fetch with ky's timing: `timeout` bounds only
 * the wait for response headers (ky's meaning); the body read is bounded by
 * the caller's signal and the pinned fetch's overall download deadline, so a
 * slow but size-capped body is not cut off at the header timeout (s216 Codex).
 */
const fetchHop = async (
  url: string,
  signal: AbortSignal,
  headerTimeoutMs: number,
): Promise<Response> => {
  const headers = new AbortController()
  const timer = setTimeout(
    () => headers.abort(new DOMException("headers timed out", "TimeoutError")),
    headerTimeoutMs,
  )
  try {
    return await outboundFetch(
      url,
      { redirect: "manual", signal: AbortSignal.any([signal, headers.signal]) },
      { timeoutMs: DOWNLOAD_TIMEOUT_MS },
    )
  } finally {
    clearTimeout(timer)
  }
}

type DownloadWithByteLimitOptions = {
  allowedMimeTypes?: ReadonlySet<string>
  label: string
  maxBytes: number
  signal: AbortSignal
  timeout?: number
  url: string
}

type DownloadedBuffer = {
  buffer: Buffer
  contentType: string
  rawContentType: string
}

function parseContentLength(response: Response): number | null {
  const header = response.headers.get("content-length")
  if (header === null) {
    return null
  }

  const parsed = Number.parseInt(header, 10)
  return Number.isNaN(parsed) ? null : parsed
}

function assertContentLengthWithinLimit(
  response: Response,
  label: string,
  maxBytes: number,
) {
  const declared = parseContentLength(response)
  if (declared !== null && declared > maxBytes) {
    throw new ExpectedHeavyStepError(
      `${label} exceeds size limit: ${declared} bytes (max ${maxBytes})`,
    )
  }
}

async function assertSafeDownloadUrl(
  url: string,
  label: string,
): Promise<void> {
  try {
    await assertPublicUrl(url, `${label} URL`)
  } catch (error) {
    throw new ExpectedHeavyStepError(`Unsafe ${label} URL`, { cause: error })
  }
}

export async function downloadWithByteLimit({
  allowedMimeTypes,
  label,
  maxBytes,
  signal,
  timeout,
  url,
}: DownloadWithByteLimitOptions): Promise<DownloadedBuffer> {
  const { response } = await fetchFollowingSafeRedirects({
    errors: {
      tooManyRedirects: () =>
        new ExpectedHeavyStepError(`${label} download exceeded redirect limit`),
      noLocationHeader: () =>
        new ExpectedHeavyStepError(`${label} redirect has no location`),
      invalidRedirectLocation: (_location, cause) =>
        new ExpectedHeavyStepError(
          `${label} redirect has an invalid location`,
          {
            cause,
          },
        ),
    },
    // Each hop is DoH-checked (validateUrl, for a clear early error) AND
    // pinned at connect by outboundFetch, which is the real guard: a
    // rebinding name cannot swap in a private address between the two (s216).
    fetchImpl: (candidateUrl) =>
      fetchHop(
        candidateUrl,
        signal,
        timeout ?? DEFAULT_HEADER_TIMEOUT_MS,
      ).catch((error: unknown) => {
        if (isSsrfFetchError(error)) {
          throw new ExpectedHeavyStepError(`Unsafe ${label} URL`, {
            cause: error,
          })
        }
        throw error
      }),
    maxRedirectHops: MAX_REDIRECTS,
    url,
    validateUrl: (candidateUrl) => assertSafeDownloadUrl(candidateUrl, label),
  })

  if (!response.ok) {
    const message = `${label} download failed with status ${response.status}`
    if (response.status >= 500) {
      throw new Error(message)
    }
    throw new ExpectedHeavyStepError(message)
  }

  assertContentLengthWithinLimit(response, label, maxBytes)

  const rawContentType = response.headers.get("content-type") ?? ""
  const contentType = rawContentType.split(";")[0]?.trim() ?? ""
  if (allowedMimeTypes && !allowedMimeTypes.has(contentType)) {
    throw new ExpectedHeavyStepError(
      `Unsupported ${label} format: ${rawContentType || "unknown"}`,
    )
  }

  const buffer = await readBodyWithLimit(
    response,
    maxBytes,
    (limit) =>
      new ExpectedHeavyStepError(
        `${label} body exceeds size limit: >${limit} bytes`,
      ),
  )
  return { buffer, contentType, rawContentType }
}
