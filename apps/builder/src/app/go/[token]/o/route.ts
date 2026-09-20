import {
  contactInboxService,
  isTrackedLinkToken,
  markBulktextOpen,
  trackedLinkService,
} from "@chatbotx.io/business"
import { NextResponse } from "next/server"
import { logger } from "@/lib/log"
import { loadServableWorkspace } from "@/lib/workspace/load-servable-workspace"

/**
 * The open beacon of a mail sent through a `bulktextSend` step with
 * `trackOpens` on: a 1x1 transparent GIF whose fetch is the open. No preview
 * heuristic here (mail clients fetch images through proxies, and that fetch
 * IS the open); Apple Mail's privacy prefetch is a known false positive.
 * Only a `pixel` row answers; a link token at this path is a 404.
 */
const GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
)

type RouteContext = { params: Promise<{ token: string }> }

const gif = () =>
  new NextResponse(GIF, {
    status: 200,
    headers: {
      "content-type": "image/gif",
      "content-length": String(GIF.length),
      "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
      pragma: "no-cache",
      expires: "0",
    },
  })

export async function GET(_request: Request, context: RouteContext) {
  const { token } = await context.params
  if (!isTrackedLinkToken(token)) {
    return NextResponse.json({ code: "notFound" }, { status: 404 })
  }
  const link = await trackedLinkService.findByToken(token)
  if (link?.kind !== "pixel") {
    return NextResponse.json({ code: "notFound" }, { status: 404 })
  }
  const { servable } = await loadServableWorkspace(link.workspaceId)
  if (!servable) {
    return NextResponse.json(
      { code: "workspaceScheduledDeletion" },
      { status: 410 },
    )
  }
  const now = new Date()
  await trackedLinkService.recordOpen(token, now)
  if (link.contactInboxId !== null) {
    try {
      const contactInbox = await contactInboxService.findBy({
        where: { id: link.contactInboxId },
      })
      if (contactInbox) {
        await markBulktextOpen({
          workspaceId: link.workspaceId,
          contactId: link.contactId,
          contactInbox: {
            id: contactInbox.id,
            inboxId: contactInbox.inboxId,
            channel: contactInbox.channel,
          },
          at: now,
        })
      }
    } catch (error) {
      logger.error(
        error,
        `tracked pixel open not marked on the contact: ${token}`,
      )
    }
  }
  return gif()
}
