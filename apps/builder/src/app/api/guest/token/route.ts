import {
  integrationWebchatService,
  isWorkspaceScheduledForDeletion,
  workspaceService,
} from "@chatbotx.io/business"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { type NextRequest, NextResponse } from "next/server"
import z from "zod"
import { isFirstPartyOrigin } from "@/features/integration-webchat/lib/authorized-domain"
import {
  refineGuestIdWorkspace,
  zodGuestConversationId,
} from "@/features/integration-webchat/lib/guest-conversation-id"
import { refreshWebchatAccessToken } from "@/features/integration-webchat/lib/refresh-webchat-token"
import { readWebchatAccessToken } from "@/features/integration-webchat/lib/webchat-access-token"
import { getDomainFromHeader } from "@/lib/domain"
import { logger } from "@/lib/log"
import {
  checkGuestRateLimit,
  getGuestClientIp,
} from "@/lib/rate-limit/guest-rate-limit"

const refreshRequest = z
  .strictObject({
    workspaceId: zodBigintAsString(),
    webchatId: zodBigintAsString(),
    // Shape-checked only: no guest secret here (s215) because this route
    // reads no conversation and returns only a session token, which alone
    // opens nothing (every conversation route also needs the guest secret).
    // Anything that ever keys off this id here must check the secret first.
    guestConversationId: zodGuestConversationId(),
    accessToken: z.string().min(1).max(2048),
    parentOrigin: z.string().max(2048).nullish(),
  })
  .superRefine(refineGuestIdWorkspace)

const headers = () =>
  new Headers({ "Cache-Control": "no-store", Vary: "Origin" })
const denied = (status: 400 | 403 | 429) =>
  NextResponse.json({ accessToken: null }, { status, headers: headers() })

/**
 * Trades the widget's guest token for a fresh one before (or up to a day
 * after) it expires, re-running the embed gate (owner s210). Same caller rules
 * as /api/guest/messages: the widget iframe only, no CORS.
 */
export async function POST(req: NextRequest) {
  try {
    // Same rule as /api/guest/messages: a foreign browser Origin is refused;
    // a missing one is tolerated (some WebViews omit it), since refusing it
    // here alone would strand a widget whose sends still work (s210 skeptic).
    const appHost = await getDomainFromHeader()
    if (!isFirstPartyOrigin(req.headers.get("origin"), appHost)) {
      return denied(403)
    }
    const parsed = refreshRequest.safeParse(await req.json().catch(() => null))
    if (!parsed.success) {
      return denied(400)
    }
    const data = parsed.data

    // Only a token this hub signed, for the webchat it names, goes further:
    // junk is refused here with no rate-limit key or DB read, and both
    // buckets key on SIGNED fields. Body-keyed buckets let anyone burn a
    // guest's budget (its guestConversationId) or rotate past every limit
    // (webchatId) (s212 probes). `sid` survives refreshes; a pre-s212 token
    // falls back to its signature until its first refresh.
    const own = await readWebchatAccessToken(data.accessToken)
    if (
      !own ||
      own.webchatId !== data.webchatId ||
      own.workspaceId !== data.workspaceId
    ) {
      return denied(403)
    }
    const rateLimit = await checkGuestRateLimit({
      clientIp: getGuestClientIp(req.headers),
      guestConversationId:
        own.sid ??
        data.accessToken.slice(data.accessToken.lastIndexOf(".") + 1),
      webchatId: own.webchatId,
      scope: "token-refresh",
    })
    if (rateLimit.limited) {
      const res = denied(429)
      res.headers.set("Retry-After", String(rateLimit.retryAfter))
      return res
    }

    const accessToken = await refreshWebchatAccessToken(
      {
        token: data.accessToken,
        workspaceId: data.workspaceId,
        webchatId: data.webchatId,
        parentOrigin: data.parentOrigin,
        appHost,
      },
      {
        loadAuthorizedDomains: async ({ workspaceId, webchatId }) =>
          (
            await integrationWebchatService.findByIdForWorkspaceOrNull({
              id: webchatId,
              workspaceId,
            })
          )?.authorizedDomains ?? null,
        isWorkspaceActive: async (workspaceId) => {
          const workspace = await workspaceService.find({
            where: { id: workspaceId },
          })
          return !!workspace && !isWorkspaceScheduledForDeletion(workspace)
        },
      },
    )
    if (!accessToken) {
      return denied(403)
    }
    return NextResponse.json({ accessToken }, { headers: headers() })
  } catch (error) {
    // Fail closed: the widget keeps its current token and reloads if needed.
    logger.warn({ err: error }, "webchat guest token refresh failed")
    return NextResponse.json(
      { accessToken: null },
      { status: 500, headers: headers() },
    )
  }
}
