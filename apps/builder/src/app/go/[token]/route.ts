import {
  contactInboxService,
  isTrackedLinkToken,
  markBulktextClick,
  trackedLinkService,
} from "@chatbotx.io/business"
import { NextResponse } from "next/server"
import { logger } from "@/lib/log"
import { isLinkPrefetch } from "@/lib/tracked-link/prefetch"
import { loadServableWorkspace } from "@/lib/workspace/load-servable-workspace"

/**
 * Public redirect for a tracked link minted by a `bulktextSend` step with
 * `trackLinks` on. Nothing from the request is trusted: the token selects a
 * row whose destination was validated as http(s) when it was minted, so
 * there is no open-redirect surface and no signed `u=` parameter.
 *
 * A human-looking visit records a click and marks the contact (tag
 * `bt-clicked`, field `bt_last_click`) so a flow can branch on it; a preview
 * fetch only bumps `prefetchCount`. The side effects are best-effort: a
 * failed tag write is logged and the person is still redirected.
 */
type RouteContext = { params: Promise<{ token: string }> }

const resolveToken = async (context: RouteContext): Promise<string | null> => {
  const { token } = await context.params
  return isTrackedLinkToken(token) ? token : null
}

export async function GET(request: Request, context: RouteContext) {
  const token = await resolveToken(context)
  if (token === null) {
    return NextResponse.json({ code: "notFound" }, { status: 404 })
  }
  const link = await trackedLinkService.findByToken(token)
  if (!link) {
    return NextResponse.json({ code: "notFound" }, { status: 404 })
  }
  const { servable } = await loadServableWorkspace(link.workspaceId)
  if (!servable) {
    return NextResponse.json(
      { code: "workspaceScheduledDeletion" },
      { status: 410 },
    )
  }

  const prefetch = isLinkPrefetch(request)
  const now = new Date()
  await trackedLinkService.recordVisit(
    token,
    prefetch ? "prefetch" : "click",
    now,
  )

  if (!prefetch && link.contactInboxId !== null) {
    try {
      const contactInbox = await contactInboxService.findBy({
        where: { id: link.contactInboxId },
      })
      if (contactInbox) {
        await markBulktextClick({
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
        `tracked link click not marked on the contact: ${token}`,
      )
    }
  }

  return NextResponse.redirect(link.url, { status: 302 })
}

/** A HEAD probe redirects like GET but never records anything. */
export async function HEAD(_request: Request, context: RouteContext) {
  const token = await resolveToken(context)
  const link =
    token === null ? undefined : await trackedLinkService.findByToken(token)
  if (!link) {
    return new NextResponse(null, { status: 404 })
  }
  return NextResponse.redirect(link.url, { status: 302 })
}
