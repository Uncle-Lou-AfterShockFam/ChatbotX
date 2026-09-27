import {
  contactInboxService,
  conversationService,
  isWorkspaceScheduledForDeletion,
  workspaceService,
} from "@chatbotx.io/business"
import { type NextRequest, NextResponse } from "next/server"
import { getTranslations } from "next-intl/server"
import {
  isFirstPartyOrigin,
  isGuestOriginAllowed,
} from "@/features/integration-webchat/lib/authorized-domain"
import { verifyWebchatAccessToken } from "@/features/integration-webchat/lib/webchat-access-token"
import { findIntegrationWebchat } from "@/features/integration-webchat/queries"
import { handleCreateWebchatMessage } from "@/features/messages/actions/create-webchat-message.action"
import { listMessages } from "@/features/messages/queries"
import { createWebchatMessageRequest } from "@/features/messages/schema/mutation"
import { listGuestMessagesRequest } from "@/features/messages/schema/query"
import { getDomainFromHeader } from "@/lib/domain"
import { serverErrorHandler } from "@/lib/errors/server-handler"
import {
  checkGuestRateLimit,
  getGuestClientIp,
} from "@/lib/rate-limit/guest-rate-limit"

// Only the widget iframe (the hub's own origin, relative URLs) calls this
// route, so it answers no CORS at all (s210): a stranger's page that relays a
// server-minted token can no longer read or write a chat from the browser.
const guestHeaders = () => new Headers({ Vary: "Origin" })

const BEARER_TOKEN_SEPARATOR = /\s+/

const getBearerToken = (req: NextRequest) => {
  const authorization = req.headers.get("authorization")
  const [scheme, token] = authorization?.split(BEARER_TOKEN_SEPARATOR, 2) ?? []
  return scheme?.toLowerCase() === "bearer" ? token : null
}

const forbiddenResponse = async (headers: Headers) => {
  const t = await getTranslations("webchat.unauthorizedDomain")
  return NextResponse.json(
    {
      message: t("description"),
      errors: [],
    },
    { status: 403, headers },
  )
}

const rateLimitResponse = async (headers: Headers, retryAfter: number) => {
  const t = await getTranslations("webchat")
  headers.set("Retry-After", String(retryAfter))
  return NextResponse.json(
    { message: t("rateLimitExceeded"), errors: [] },
    { status: 429, headers },
  )
}

const emptyMessagesResponse = (headers: Headers) =>
  NextResponse.json(
    {
      data: [],
      nextCursor: null,
      prevCursor: null,
    },
    { headers },
  )

export function OPTIONS() {
  // No Access-Control-Allow-* headers: a cross-origin preflight fails.
  return new NextResponse(null, { headers: guestHeaders(), status: 204 })
}

export async function GET(req: NextRequest) {
  try {
    // A browser always sends Origin on a cross-origin call; only the hub's own
    // (or none: a same-origin GET) may reach a guest conversation.
    const appHost = await getDomainFromHeader()
    if (!isFirstPartyOrigin(req.headers.get("origin"), appHost)) {
      return await forbiddenResponse(guestHeaders())
    }
    const searchParams = Object.fromEntries(req.nextUrl.searchParams)
    const data = listGuestMessagesRequest.parse(searchParams)

    const workspace = await workspaceService.find({
      where: { id: data.workspaceId },
    })
    if (workspace && isWorkspaceScheduledForDeletion(workspace)) {
      return await forbiddenResponse(guestHeaders())
    }

    const rateLimit = await checkGuestRateLimit({
      clientIp: getGuestClientIp(req.headers),
      guestConversationId: data.guestConversationId,
      webchatId: data.webchatId,
    })
    if (rateLimit.limited) {
      return await rateLimitResponse(guestHeaders(), rateLimit.retryAfter)
    }

    const webchat = await findIntegrationWebchat({
      id: data.webchatId,
      workspaceId: data.workspaceId,
    })

    const bearerToken = getBearerToken(req)
    // Bind-on-first-use: always require a token bound to the presented
    // origin, then layer the optional domain allowlist on top.
    const { authorized: tokenAuthorized } = await verifyWebchatAccessToken({
      token: data.accessToken ?? bearerToken,
      origin: data.parentOrigin,
      workspaceId: data.workspaceId,
      webchatId: data.webchatId,
    })
    const authorized =
      tokenAuthorized &&
      isGuestOriginAllowed(
        data.parentOrigin,
        webchat.authorizedDomains,
        appHost,
      )
    const headers = guestHeaders()
    if (!authorized) {
      return await forbiddenResponse(headers)
    }

    const contactInbox = await contactInboxService.findLatestBySource({
      inboxId: webchat.inboxId,
      sourceId: data.guestConversationId,
      workspaceId: data.workspaceId,
    })

    if (!contactInbox) {
      return emptyMessagesResponse(headers)
    }

    const conversation = await conversationService.findBy({
      where: {
        workspaceId: data.workspaceId,
        contactId: contactInbox.contactId,
      },
    })

    if (!conversation) {
      return emptyMessagesResponse(headers)
    }

    const result = await listMessages({
      ...data,
      contactInboxId: contactInbox.id,
      workspaceId: conversation.workspaceId,
      conversationId: conversation.id,
    })

    return NextResponse.json(result, { headers })
  } catch (e) {
    return serverErrorHandler(e, guestHeaders())
  }
}

export async function POST(req: NextRequest) {
  try {
    // A browser always sends Origin on a cross-origin call; only the hub's own
    // (or none: a same-origin GET) may reach a guest conversation.
    const appHost = await getDomainFromHeader()
    if (!isFirstPartyOrigin(req.headers.get("origin"), appHost)) {
      return await forbiddenResponse(guestHeaders())
    }
    const data = await req.json()
    const parsedInput = createWebchatMessageRequest.parse(data)

    const webchat = await findIntegrationWebchat({
      id: parsedInput.webchatId,
      workspaceId: parsedInput.workspaceId,
    })
    const bearerToken = getBearerToken(req)
    // Bind-on-first-use: always require a token bound to the presented
    // origin, then layer the optional domain allowlist on top.
    const { authorized: tokenAuthorized } = await verifyWebchatAccessToken({
      token: parsedInput.accessToken ?? bearerToken,
      origin: parsedInput.parentOrigin,
      workspaceId: parsedInput.workspaceId,
      webchatId: parsedInput.webchatId,
    })
    const authorized =
      tokenAuthorized &&
      isGuestOriginAllowed(
        parsedInput.parentOrigin,
        webchat.authorizedDomains,
        appHost,
      )
    const headers = guestHeaders()
    if (!authorized) {
      return await forbiddenResponse(headers)
    }

    const message = await handleCreateWebchatMessage({
      parsedInput: {
        ...parsedInput,
        accessToken: parsedInput.accessToken ?? bearerToken ?? undefined,
      },
    })

    return NextResponse.json(
      {
        data: message,
      },
      { headers },
    )
  } catch (e) {
    return serverErrorHandler(e, guestHeaders())
  }
}
