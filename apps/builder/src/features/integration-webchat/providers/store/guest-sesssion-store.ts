import type { WebchatPersistentMenu } from "@chatbotx.io/database/partials"
import type { MessageButtonTemplate } from "@chatbotx.io/sdk"
import { createId } from "@chatbotx.io/utils"
import ky from "ky"
import { createStore } from "zustand/vanilla"
import type { CreateWebchatMessageRequest } from "@/features/messages/schema/mutation"
import type { ListMessagesResponse } from "@/features/messages/schema/query"
import type { MessageResource } from "@/features/messages/schema/resource"
import type { UserResource } from "@/features/users/schema/resource"
import { getWebchatProfileFields } from "../../browser-profile-fields"
import { GUEST_SECRET_HEADER } from "../../lib/guest-conversation-id"
import { isWebchatTokenDue } from "../../lib/webchat-token-expiry"
import {
  buildGuestSessionKey,
  buildGuestStorageKey,
  type GuestSessionCredentials,
  LEGACY_GLOBAL_KEY,
  readGuestSession,
  safeStorageRemove,
  writeGuestSession,
} from "./lib/guest-session"
import type { WebchatClientConfig } from "./lib/webchat-client-config"

export type GuestSessionState = {
  // default state
  guestConversationId: string | null
  /** The visitor's credential, minted with the id (s215); sent on every call. */
  guestSecret: string | null
  /**
   * The pair this page load minted, kept to start over when the stored one is
   * refused (a secret from before a key rotation).
   */
  serverGuestSession: GuestSessionCredentials | null
  isNewGuestSession: boolean
  accessToken: string | null
  /** Client clock (ms) when `accessToken` arrived; refreshes are timed from it. */
  accessTokenReceivedAt: number
  /**
   * The embedding page's origin as the server saw it (the Referer the access
   * token was minted from, null when none was sent). Every guest request
   * presents this one value so it always matches the token.
   */
  parentOrigin: string | null
  /**
   * Resolved workspace logo URL, already gated server-side on
   * `config.showLogo` (undefined when the flag is off or no logo is set).
   * Kept as separate store state rather than a `WebchatClientConfig` field
   * so the DTO's allow-listed key set — asserted by
   * webchat-guest-session.test.ts — stays unchanged.
   */
  workspaceLogoUrl?: string
  user: UserResource | null
  config: WebchatClientConfig

  // messages
  messages: MessageResource[]
  nextCursorMessage: string | null
  isLoadMoreMessage: boolean
  hasNextMessagePage: boolean
  isTyping: boolean
}

export type GuestSessionActions = {
  setGuestUser: (user: UserResource) => void
  initGuestSession: (serverSession: GuestSessionCredentials) => void
  /**
   * The guest routes refused the stored secret: drop it and continue as the
   * pair this page load minted, a fresh conversation. At most once per load.
   */
  restartGuestSession: () => void

  // messages
  appendMessage: (message: Partial<MessageResource>) => MessageResource
  loadMoreMessages: (
    guestConversationId: string,
    perPage: number,
  ) => Promise<void>
  handleNewMessage: (message: MessageResource) => void
  /** The optimistic bubble of a text send, keyed by the send's clientId. */
  sendMessage: (content: string, clientId?: string) => void
  /**
   * Never rejects: a postback that does not land marks its bubble failed
   * (the button's onClick has no catch).
   */
  sendPostback: (button: MessageButtonTemplate) => Promise<void>
  /** Flags the visitor's optimistic bubble whose send did not land. */
  markSendFailed: (clientId: string, error: string) => void
  setIsTyping: (isTyping: boolean) => void

  getMenus: () => WebchatPersistentMenu[]

  /**
   * Trades the guest token for a fresh one (s210). One request at a time.
   * "refused": the server said no (the gate no longer passes, or the token is
   * too old): retrying is pointless. "failed": network/5xx/429, worth a later
   * retry. Either way the current token stays.
   */
  refreshAccessToken: () => Promise<TokenRefreshOutcome>
  /**
   * The token to send now: refreshed first when it is due (never more than
   * once a minute), so a send after a long idle does not 403.
   */
  freshAccessToken: () => Promise<string | null>
}

export type TokenRefreshOutcome = "refreshed" | "refused" | "failed"

export type GuestSessionStore = GuestSessionState & GuestSessionActions

/**
 * The tooltip detail of a failed guest send: the guest route's translated
 * `message` when it answered, else the error's own text. Never empty (an empty
 * `sendError` hides the badge).
 */
export const sendErrorDetail = async (error: unknown): Promise<string> => {
  const response = (error as { response?: Response } | null)?.response
  if (response) {
    const body = (await response
      .clone()
      .json()
      .catch(() => null)) as { message?: unknown } | null
    if (typeof body?.message === "string" && body.message) {
      return body.message
    }
    return `HTTP ${response.status}`
  }
  return error instanceof Error && error.message
    ? error.message
    : "Network error"
}

export const createGuestSessionStore = (
  props: WebchatClientConfig,
  accessToken: string | null = null,
  workspaceLogoUrl?: string,
  parentOrigin: string | null = null,
) => {
  let refreshInFlight: Promise<TokenRefreshOutcome> | null = null

  return createStore<GuestSessionStore>((set, get) => {
    /**
     * One guest call, retried once with a refreshed token after a 403. A 401
     * is a refused guest secret (s215): the widget starts over as the pair
     * this page load minted, and the call still fails.
     */
    const withFreshToken = async <T>(
      call: (accessToken: string | null) => Promise<T>,
    ): Promise<T> => {
      try {
        return await call(get().accessToken)
      } catch (error) {
        const status = (error as { response?: { status?: number } } | null)
          ?.response?.status
        if (status === 401) {
          get().restartGuestSession()
          throw error
        }
        if (
          status !== 403 ||
          (await get().refreshAccessToken()) !== "refreshed"
        ) {
          throw error
        }
        return await call(get().accessToken)
      }
    }

    return {
      // default state
      guestConversationId: null,
      guestSecret: null,
      serverGuestSession: null,
      isNewGuestSession: false,
      accessToken,
      accessTokenReceivedAt: Date.now(),
      parentOrigin,
      workspaceLogoUrl,
      user: null,
      config: props,

      // messages related state
      messages: [],
      nextCursorMessage: null,
      isLoadMoreMessage: false,
      hasNextMessagePage: true,

      isTyping: false,

      initGuestSession: (serverSession: GuestSessionCredentials) => {
        const { guestConversationId, config } = get()
        if (guestConversationId) {
          return
        }
        set({ serverGuestSession: serverSession })

        // The pre-s213 global key and the pre-s215 per-webchat key held a
        // bare id with no secret. Every guest route refuses such a visitor
        // (owner s215: the server cannot tell the owner from someone who read
        // the id off an export), so they start fresh and the keys go.
        safeStorageRemove(LEGACY_GLOBAL_KEY)
        safeStorageRemove(buildGuestStorageKey(config.workspaceId, config.id))

        // A stored pair is kept only with a minted id of THIS workspace and a
        // well-formed secret; anything else is replaced by the server pair.
        const sessionKey = buildGuestSessionKey(config.workspaceId, config.id)
        const stored = readGuestSession(sessionKey, config.workspaceId)
        if (stored) {
          set({ ...stored, isNewGuestSession: false })
          return
        }

        writeGuestSession(sessionKey, serverSession)
        set({ ...serverSession, isNewGuestSession: true })
      },

      restartGuestSession: () => {
        const { serverGuestSession, guestConversationId, config } = get()
        if (
          !serverGuestSession ||
          guestConversationId === serverGuestSession.guestConversationId
        ) {
          return
        }
        writeGuestSession(
          buildGuestSessionKey(config.workspaceId, config.id),
          serverGuestSession,
        )
        set({
          ...serverGuestSession,
          isNewGuestSession: true,
          messages: [],
          nextCursorMessage: null,
          hasNextMessagePage: true,
        })
      },

      setGuestUser: (user: UserResource) => {
        set({ user })
      },

      loadMoreMessages: async (
        guestConversationId: string,
        perPage: number,
      ) => {
        const {
          isLoadMoreMessage,
          hasNextMessagePage,
          nextCursorMessage,
          messages,
          config,
          parentOrigin,
        } = get()

        if (isLoadMoreMessage || !hasNextMessagePage) {
          return
        }

        set({ isLoadMoreMessage: true })

        try {
          const params = new URLSearchParams({
            perPage: `${perPage}`,
            cursor: nextCursorMessage ?? "",
            guestConversationId,
            workspaceId: config.workspaceId,
            webchatId: config.id,
          })
          if (parentOrigin) {
            params.set("parentOrigin", parentOrigin)
          }

          const { guestSecret } = get()
          const { data, nextCursor } = await withFreshToken((accessToken) =>
            ky
              .get<ListMessagesResponse>(
                `/api/guest/messages?${params.toString()}`,
                {
                  headers: {
                    ...(accessToken
                      ? { Authorization: `Bearer ${accessToken}` }
                      : {}),
                    ...(guestSecret
                      ? { [GUEST_SECRET_HEADER]: guestSecret }
                      : {}),
                  },
                },
              )
              .json(),
          )

          set({
            messages: [...data.reverse(), ...messages],
            nextCursorMessage: nextCursor,
            hasNextMessagePage: Boolean(nextCursor),
            isLoadMoreMessage: false,
          })
        } catch (error) {
          set({ isLoadMoreMessage: false })
          console.error("Failed to load more messages:", error)
          throw error
        }
      },

      handleNewMessage: (message: MessageResource) => {
        const { messages, appendMessage } = get()

        // If the message contains the clientId, it can be sent from this tab itself.
        if (message.clientId) {
          const messageIndex = messages.findIndex(
            (m) => m.clientId === message.clientId,
          )

          if (messageIndex > -1) {
            // Replace the existing message with the updated one
            set({
              messages: messages.map((m, idx) =>
                idx === messageIndex ? { ...m, ...message } : m,
              ),
            })
            return
          }
        }

        // Append the message to the end of messages list
        appendMessage(message)
      },

      sendMessage: (text: string, clientId?: string) => {
        const { appendMessage } = get()

        appendMessage(clientId ? { text, clientId } : { text })
      },

      markSendFailed: (clientId: string, error: string) => {
        set((state) => ({
          messages: state.messages.map((m) =>
            m.clientId === clientId ? { ...m, sendError: error } : m,
          ),
        }))
      },

      sendPostback: async (button: MessageButtonTemplate) => {
        const {
          appendMessage,
          config,
          guestConversationId,
          guestSecret,
          parentOrigin,
        } = get()

        const newMessage = appendMessage({
          text: button.label,
        })

        await Promise.resolve()

        try {
          if (button.buttonType === "postback") {
            await withFreshToken((accessToken) =>
              ky.post("/api/guest/messages", {
                json: {
                  text: button.label,
                  postback: button.postback,
                  workspaceId: config.workspaceId,
                  guestConversationId,
                  guestSecret: guestSecret ?? undefined,
                  clientId: newMessage.clientId,
                  webchatId: config.id,
                  ...getWebchatProfileFields(),
                  accessToken: accessToken ?? undefined,
                  parentOrigin: parentOrigin ?? undefined,
                } as CreateWebchatMessageRequest,
                headers: accessToken
                  ? { Authorization: `Bearer ${accessToken}` }
                  : undefined,
              }),
            )
          }
        } catch (error) {
          // A refused/failed refresh or send: the bubble must not look sent.
          console.error("Failed to send postback:", error)
          get().markSendFailed(
            newMessage.clientId as string,
            await sendErrorDetail(error),
          )
        }
      },

      appendMessage: (message: Partial<MessageResource>) => {
        const newMessage: MessageResource = {
          id: createId(),
          createdAt: new Date(),
          updatedAt: new Date(),
          workspaceId: props.workspaceId,
          // inboxId: props.inboxId,
          sourceId: null,
          conversationId: "",
          text: null,
          contentAttributes: null,
          messageType: "incoming",
          contentType: "text",
          senderType: "contact",
          senderId: "",
          clientId: createId(),
          contactInboxId: "",
          deletedAt: null,
          type: "message",
          parentId: null,
          attributes: null,
          sendError: null,
          ...message,
        }

        set((state) => ({
          messages: [...state.messages, newMessage],
        }))

        return newMessage
      },

      getMenus: () => {
        const { config } = get()
        return config.persistentMenus ?? []
      },

      setIsTyping: (isTyping: boolean) => {
        set({ isTyping })
      },

      refreshAccessToken: () => {
        if (refreshInFlight) {
          return refreshInFlight
        }
        const { accessToken, config, guestConversationId, parentOrigin } = get()
        if (!(accessToken && guestConversationId)) {
          return Promise.resolve<TokenRefreshOutcome>("refused")
        }
        refreshInFlight = ky
          .post("/api/guest/token", {
            json: {
              workspaceId: config.workspaceId,
              webchatId: config.id,
              guestConversationId,
              accessToken,
              parentOrigin,
            },
            retry: 0,
          })
          .json<{ accessToken: string | null }>()
          .then(({ accessToken: fresh }): TokenRefreshOutcome => {
            if (typeof fresh !== "string" || !fresh) {
              return "refused"
            }
            set({ accessToken: fresh, accessTokenReceivedAt: Date.now() })
            return "refreshed"
          })
          .catch((error: unknown): TokenRefreshOutcome => {
            const status = (error as { response?: { status?: number } } | null)
              ?.response?.status
            return status === 400 || status === 403 ? "refused" : "failed"
          })
          .finally(() => {
            refreshInFlight = null
          })
        return refreshInFlight
      },

      freshAccessToken: async () => {
        if (isWebchatTokenDue(get().accessTokenReceivedAt, Date.now())) {
          await get().refreshAccessToken()
        }
        return get().accessToken
      },
    }
  })
}
