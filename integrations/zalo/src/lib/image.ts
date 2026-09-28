import type { Context } from "@chatbotx.io/sdk"
import { SsrfFetchError } from "@chatbotx.io/sdk/outbound-fetch"
import { createId } from "@chatbotx.io/utils"
import type { ZaloAuthValue } from "../schema/definition"
import { fetchZaloDownload, ZaloAttachmentTooLargeError } from "./download"

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
    {
      Authorization: `Bearer ${ctx.auth.tokens.accessToken}`,
      "User-Agent": "node",
    },
    "avatar",
  ).catch((error: unknown) => {
    if (
      error instanceof ZaloAttachmentTooLargeError ||
      error instanceof SsrfFetchError
    ) {
      return null
    }
    throw error
  })
  if (!download) {
    return
  }
  const originPath = `${ctx.storagePrefix}/${createId()}`
  const mimeType = download.response.headers.get("content-type") ?? "image/png"

  await ctx.uploader?.putObject(originPath, Buffer.from(download.bytes), {
    ACL: "public-read",
    ContentType: mimeType,
  })

  return originPath
}
