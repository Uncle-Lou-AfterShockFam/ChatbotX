import { beforeEach, describe, expect, test, vi } from "vitest"

const mockPutObject = vi.fn(async () => undefined)

vi.mock("../src/lib/uploader", () => ({
  uploader: { putObject: mockPutObject },
}))

vi.mock("@chatbotx.io/logger", () => ({
  getChildLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}))

const {
  DEFAULT_MAX_URL_DOWNLOAD_BYTES,
  uploadFileFromUrl,
  UploadValidationError,
} = await import("../src/lib/upload")

function streamResponse(
  chunks: Uint8Array[],
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk)
      }
      controller.close()
    },
  })
  return new Response(stream, {
    status: init.status ?? 200,
    headers: init.headers,
  })
}

beforeEach(() => {
  mockPutObject.mockClear()
})

const fetchReturning = (response: Response) => vi.fn(async () => response)

class SsrfFetchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SsrfFetchError"
  }
}

describe("uploadFileFromUrl (s216: always through the injected pinned fetch)", () => {
  test("throws when the body exceeds maxBytes even though content-length lies small", async () => {
    const fetchImpl = fetchReturning(
      streamResponse([new Uint8Array(20)], {
        headers: { "content-length": "1", "content-type": "text/plain" },
      }),
    )
    await expect(
      uploadFileFromUrl("https://example.com/file.txt", "path/to/file", {
        acl: "private",
        maxBytes: 10,
        fetchImpl,
      }),
    ).rejects.toThrow(UploadValidationError)
    expect(mockPutObject).not.toHaveBeenCalled()
  })

  test("records the real streamed byte count and the final URL's name", async () => {
    const chunk = new TextEncoder().encode("hello world")
    const response = streamResponse([chunk], {
      headers: { "content-length": "1", "content-type": "text/plain" },
    })
    Object.defineProperty(response, "url", {
      value: "https://cdn.example.com/final-name.txt",
    })
    const fetchImpl = fetchReturning(response)

    const result = await uploadFileFromUrl(
      "https://example.com/file.txt",
      "path/to/file",
      { acl: "private", maxBytes: 1000, fetchImpl },
    )

    expect(fetchImpl).toHaveBeenCalledWith("https://example.com/file.txt")
    expect(result.size).toBe(chunk.byteLength)
    expect(result.name).toBe("final-name.txt")
    expect(mockPutObject).toHaveBeenCalledWith(
      "path/to/file",
      expect.anything(),
      expect.objectContaining({
        ContentLength: chunk.byteLength,
        ACL: "private",
      }),
    )
  })

  test("a refused URL is a caller-fault UploadValidationError; nothing is stored", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.reject(
        new SsrfFetchError("[ssrf-guard] unsafeAddress: metadata.internal"),
      ),
    )
    const error = await uploadFileFromUrl(
      "http://metadata.internal/latest",
      "path/to/file",
      { fetchImpl },
    ).then(
      () => null,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(UploadValidationError)
    // The guard's message echoes the host; the caller-facing one does not.
    expect((error as Error).message).toBe("The provided URL is not allowed")
    expect(mockPutObject).not.toHaveBeenCalled()
  })

  test("any other fetch failure passes through as an infrastructure error", async () => {
    const outage = new Error(
      "[ssrf-guard] the pinned outbound fetch is not installed",
    )
    const fetchImpl = vi.fn(() => Promise.reject(outage))
    await expect(
      uploadFileFromUrl("https://example.com/x", "path/to/file", { fetchImpl }),
    ).rejects.toBe(outage)
  })

  test("a non-2xx answer is refused", async () => {
    const fetchImpl = fetchReturning(new Response("nope", { status: 404 }))
    await expect(
      uploadFileFromUrl("https://example.com/x", "path/to/file", { fetchImpl }),
    ).rejects.toThrow("Failed to download file: 404")
  })

  test("the default cap applies when the caller names none", async () => {
    const fetchImpl = fetchReturning(
      streamResponse([new Uint8Array(1)], {
        headers: {
          "content-length": String(DEFAULT_MAX_URL_DOWNLOAD_BYTES + 1),
        },
      }),
    )
    await expect(
      uploadFileFromUrl("https://example.com/x", "path/to/file", { fetchImpl }),
    ).rejects.toThrow("maximum allowed size")
  })

  test("public-read stays the default ACL", async () => {
    const fetchImpl = fetchReturning(
      streamResponse([new TextEncoder().encode("x")]),
    )
    await uploadFileFromUrl("https://example.com/x", "path/to/file", {
      fetchImpl,
    })
    expect(mockPutObject).toHaveBeenCalledWith(
      "path/to/file",
      expect.anything(),
      expect.objectContaining({ ACL: "public-read" }),
    )
  })
})
