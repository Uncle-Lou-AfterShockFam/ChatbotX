import type { Context } from "@chatbotx.io/sdk"
import {
  OutboundFetchNotInstalledError,
  type OutboundRequestInit,
  registerOutboundFetch,
  SsrfFetchError,
} from "@chatbotx.io/sdk/outbound-fetch"
import { HttpResponse, http, server } from "@chatbotx.io/vitest-config/msw"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import {
  getMessageAttachmentEntity,
  uploadAttachment,
} from "../src/api/message"
import {
  ZALO_DOWNLOAD_MAX_BYTES,
  ZaloAttachmentTooLargeError,
} from "../src/lib/download"
import { ZaloException } from "../src/lib/exception"
import { fetchAndReuploadImage } from "../src/lib/image"
import type { ZaloAuthValue } from "../src/schema/definition"
import type { MessageAttachment } from "../src/schema/webhook"

// s219: every flow- or webhook-supplied URL the Zalo integration downloads
// goes through the pinned outbound fetch (never cross-fetch / global fetch)
// and is read under a byte cap.

const ACCESS_TOKEN = "ZALO_TOKEN"
const auth = { tokens: { accessToken: ACCESS_TOKEN } } as ZaloAuthValue
const putObject = vi.fn(async () => undefined)
const ctx = {
  auth,
  storagePrefix: "public/space/ws/zalo",
  uploader: { putObject },
} as unknown as Context<ZaloAuthValue>

const REGISTRY_KEY = Symbol.for("chatbotx.outboundFetch")
const uninstall = () => {
  delete (globalThis as Record<symbol, unknown>)[REGISTRY_KEY]
}

type Call = { url: string; init?: OutboundRequestInit }
let calls: Call[] = []

const install = (answer: (url: string) => Response | Promise<Response>) => {
  registerOutboundFetch(async (input, init) => {
    calls.push({ url: String(input), init })
    return await answer(String(input))
  })
}

const PNG_1X1 = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
)

const streamOf = (chunk: Uint8Array, times: number) => {
  let sent = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= times) {
        controller.close()
        return
      }
      sent += 1
      controller.enqueue(chunk)
    },
  })
}

beforeEach(() => {
  calls = []
  putObject.mockClear()
  vi.stubGlobal("fetch", () => {
    throw new Error("unpinned global fetch reached")
  })
})

afterEach(() => {
  uninstall()
  vi.unstubAllGlobals()
})

describe("uploadAttachment", () => {
  test("downloads through the pinned fetch, then uploads to Zalo", async () => {
    vi.unstubAllGlobals() // the Zalo API call itself is a fixed-host ky request
    install(
      () =>
        new Response(PNG_1X1, {
          headers: { "content-type": "image/png" },
        }),
    )
    server.use(
      http.post("https://openapi.zalo.me/v2.0/oa/upload/image", () =>
        HttpResponse.json({ error: 0, data: { attachment_id: "att-1" } }),
      ),
    )

    const result = await uploadAttachment(
      auth,
      "image",
      "https://cdn.example.com/a.png",
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe("https://cdn.example.com/a.png")
    expect(result).toMatchObject({ width: 1, height: 1 })
  })

  test("a private address is refused before any upload", async () => {
    install((url) => Promise.reject(new SsrfFetchError("unsafeAddress", url)))

    const error = await uploadAttachment(
      auth,
      "file",
      "http://169.254.169.254/latest/meta-data",
    ).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ZaloException)
    expect((error as ZaloException).originError).toBeInstanceOf(SsrfFetchError)
  })

  test("fails closed when the pinned fetch is not installed", async () => {
    const error = await uploadAttachment(
      auth,
      "file",
      "https://cdn.example.com/a.pdf",
    ).catch((caught: unknown) => caught)

    expect((error as ZaloException).originError).toBeInstanceOf(
      OutboundFetchNotInstalledError,
    )
  })

  test("a declared Content-Length over the cap is refused unread", async () => {
    install(
      () =>
        new Response("x", {
          headers: {
            "content-type": "application/pdf",
            "content-length": String(ZALO_DOWNLOAD_MAX_BYTES + 1),
          },
        }),
    )

    await expect(
      uploadAttachment(auth, "file", "https://cdn.example.com/big.pdf"),
    ).rejects.toBeInstanceOf(ZaloAttachmentTooLargeError)
  })

  test("an undeclared body is cut off once it passes the cap", async () => {
    const chunk = new Uint8Array(1024 * 1024)
    install(
      () =>
        new Response(streamOf(chunk, 11), {
          headers: { "content-type": "application/pdf" },
        }),
    )

    await expect(
      uploadAttachment(auth, "file", "https://cdn.example.com/stream.pdf"),
    ).rejects.toBeInstanceOf(ZaloAttachmentTooLargeError)
  })

  test("a non-2xx download is a ZaloException", async () => {
    install(() => new Response("nope", { status: 404 }))

    await expect(
      uploadAttachment(auth, "file", "https://cdn.example.com/gone.pdf"),
    ).rejects.toThrow("Failed to fetch file")
  })
})

describe("getMessageAttachmentEntity", () => {
  const attachment = {
    type: "image",
    payload: { url: "https://zalo-cdn.example.com/in.png" },
  } as MessageAttachment

  test("sends the bearer token through the pinned fetch and stores the bytes", async () => {
    install(
      () =>
        new Response(PNG_1X1, {
          headers: { "content-type": "image/png" },
        }),
    )

    const entity = await getMessageAttachmentEntity({ ctx, attachment })

    expect(calls[0]?.url).toBe("https://zalo-cdn.example.com/in.png")
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe(
      `Bearer ${ACCESS_TOKEN}`,
    )
    expect(entity).toMatchObject({
      mimeType: "image/png",
      size: PNG_1X1.byteLength,
      width: 1,
      height: 1,
    })
    expect(putObject).toHaveBeenCalledTimes(1)
  })

  test("a refused webhook URL stores nothing", async () => {
    install((url) => Promise.reject(new SsrfFetchError("unsafeAddress", url)))

    await expect(
      getMessageAttachmentEntity({
        ctx,
        attachment: {
          ...attachment,
          payload: { url: "http://10.0.0.5/x.png" },
        } as MessageAttachment,
      }),
    ).rejects.toBeInstanceOf(ZaloException)
    expect(putObject).not.toHaveBeenCalled()
  })
})

describe("fetchAndReuploadImage", () => {
  test("a non-2xx avatar answer is no avatar, as before", async () => {
    install(() => new Response("", { status: 403 }))

    await expect(
      fetchAndReuploadImage({ ctx, avatarUrl: "https://zalo.example/a.jpg" }),
    ).resolves.toBeUndefined()
    expect(putObject).not.toHaveBeenCalled()
  })

  test("a refused avatar URL throws and stores nothing", async () => {
    install((url) => Promise.reject(new SsrfFetchError("unsafeAddress", url)))

    await expect(
      fetchAndReuploadImage({ ctx, avatarUrl: "http://127.0.0.1/a.jpg" }),
    ).rejects.toBeInstanceOf(SsrfFetchError)
    expect(putObject).not.toHaveBeenCalled()
  })
})
