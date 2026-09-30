import type { Context } from "@chatbotx.io/sdk"
import { isSsrfFetchError } from "@chatbotx.io/sdk/outbound-fetch"
import { createId } from "@chatbotx.io/utils"
import type { ZaloAuthValue } from "../schema/definition"
import {
  fetchZaloDownload,
  ZaloAttachmentTooLargeError,
  zaloDownloadHeaders,
} from "./download"

export const fetchAndReuploadImage = async ({
  ctx,
  avatarUrl,
}: {
  ctx: Context<ZaloAuthValue>
  avatarUrl: string
}): Promise<string | undefined> => {
  // The avatar is optional profile data: an unreachable, refused or
  // oversized one is no avatar, never a failed profile sync (s219).
  const download = await fetchZaloDownload(
    avatarUrl,
    zaloDownloadHeaders(avatarUrl, ctx.auth.tokens.accessToken, "node"),
    "avatar",
  ).catch((error: unknown) => {
    if (
      error instanceof ZaloAttachmentTooLargeError ||
      isSsrfFetchError(error)
    ) {
      return null
    }
    throw error
  })
  const mimeType = download?.response.headers.get("content-type") ?? "image/png"
  // Only an image is stored as an avatar (a remote text/html answer is never
  // published to storage under the contact's avatar).
  if (!(download && mimeType.startsWith("image/"))) {
    return
  }
  const originPath = `${ctx.storagePrefix}/${createId()}`

  await ctx.uploader?.putObject(originPath, Buffer.from(download.bytes), {
    ACL: "public-read",
    ContentType: mimeType,
  })

  return originPath
}
