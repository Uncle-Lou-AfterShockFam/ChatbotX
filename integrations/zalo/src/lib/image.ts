import type { Context } from "@chatbotx.io/sdk"
import { createId } from "@chatbotx.io/utils"
import type { ZaloAuthValue } from "../schema/definition"
import { fetchZaloDownload } from "./download"

export const fetchAndReuploadImage = async ({
  ctx,
  avatarUrl,
}: {
  ctx: Context<ZaloAuthValue>
  avatarUrl: string
}): Promise<string | undefined> => {
  const download = await fetchZaloDownload(
    avatarUrl,
    {
      Authorization: `Bearer ${ctx.auth.tokens.accessToken}`,
      "User-Agent": "node",
    },
    "avatar",
  )
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
