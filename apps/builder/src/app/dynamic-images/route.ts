import { contactInboxService } from "@chatbotx.io/business"
import {
  dynamicImageService,
  getDynamicElementIds,
} from "@chatbotx.io/business/dynamic-image"
import { verifyDynamicImageToken } from "@chatbotx.io/encryption/dynamic-image-token"
import { resolveContactVariablesDeep } from "@chatbotx.io/variables"
import { type NextRequest, NextResponse } from "next/server"
import { checkDynamicImageRateLimit } from "@/lib/rate-limit/dynamic-image-rate-limit"
import { loadServableWorkspace } from "@/lib/workspace/load-servable-workspace"

export const GET = async (request: NextRequest) => {
  const dynamicImageId = request.nextUrl.searchParams.get("dynamicImageId")
  // `t` is the signed contact token the worker appends at send time (s214).
  // A bare `userId` is ignored: it was forgeable (a phone number on SMS
  // lines), so an unsigned link only ever gets the static background.
  const token = request.nextUrl.searchParams.get("t")

  if (!dynamicImageId) {
    return NextResponse.json(
      { message: "dynamicImageId is required" },
      { status: 400 },
    )
  }

  const dynamicImage = await dynamicImageService.findUnscoped(dynamicImageId)
  if (!dynamicImage) {
    return NextResponse.json(
      { message: "Dynamic image not found" },
      { status: 404 },
    )
  }

  if (!dynamicImage.enabled) {
    return NextResponse.json(
      { message: "Dynamic image is disabled" },
      { status: 404 },
    )
  }

  const { servable } = await loadServableWorkspace(dynamicImage.workspaceId)
  if (!servable) {
    return NextResponse.json(
      { code: "workspaceScheduledDeletion" },
      { status: 410 },
    )
  }

  // With no valid token there is no contact to personalize for, so fall back
  // to the config's static background rather than erroring out.
  const redirectToBackground = async () => {
    const backgroundUrl =
      await dynamicImageService.resolveBackgroundUrl(dynamicImage)
    if (!backgroundUrl) {
      return NextResponse.json(
        { message: "Dynamic image has no rendered background" },
        { status: 404 },
      )
    }
    return NextResponse.redirect(backgroundUrl, 302)
  }

  // A malformed, tampered or expired token is ordinary public input here,
  // not a fault: it degrades to the background like no token at all.
  const claims = token
    ? await verifyDynamicImageToken(token).catch(() => null)
    : null
  // The token must be for THIS image in ITS workspace: a token minted for
  // another image (or a foreign workspace) never renders this one.
  if (
    !claims ||
    claims.dynamicImageId !== dynamicImage.id ||
    claims.workspaceId !== dynamicImage.workspaceId
  ) {
    return await redirectToBackground()
  }

  const contactInbox = await contactInboxService.findInWorkspace({
    id: claims.contactInboxId,
    contactId: claims.contactId,
    workspaceId: dynamicImage.workspaceId,
  })
  if (!contactInbox) {
    return await redirectToBackground()
  }
  const contactId = contactInbox.contactId

  const cachedUrl = await dynamicImageService.findCachedUrlForContact({
    dynamicImage,
    contactId,
  })
  if (cachedUrl) {
    return NextResponse.redirect(cachedUrl, 302)
  }

  // A full render (storage get, canvas, storage put) is the expensive path:
  // past the per-(image, contact) budget the link degrades to the static
  // background (the same answer as an unsigned link), never to this
  // contact's last render, which may not exist yet (a concurrent first
  // burst, a render that failed, a save that cleared it).
  const { limited } = await checkDynamicImageRateLimit({
    dynamicImageId: dynamicImage.id,
    contactId,
  })
  if (limited) {
    return await redirectToBackground()
  }

  // Must be computed from `dynamicImage.data` (the raw, unresolved document)
  // — never from the variable-resolved copy below, which no longer carries
  // the `{{...}}` markers `isStaticElement` relies on to tell dynamic text
  // apart from static.
  const dynamicElementIds = getDynamicElementIds(dynamicImage.data)

  const withResolvedImages = await dynamicImageService.resolveDynamicElements({
    workspaceId: dynamicImage.workspaceId,
    contactId,
    document: dynamicImage.data,
  })

  const resolvedDocument = await resolveContactVariablesDeep(
    contactId,
    withResolvedImages,
    { contactInbox },
  )

  const url = await dynamicImageService.renderForContact({
    workspaceId: dynamicImage.workspaceId,
    dynamicImage,
    contactId,
    resolvedDocument,
    dynamicElementIds,
  })

  return NextResponse.redirect(url, 302)
}
