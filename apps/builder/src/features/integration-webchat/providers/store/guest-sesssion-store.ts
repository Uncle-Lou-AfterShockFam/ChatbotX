import type { WebchatPersistentMenu } from "@chatbotx.io/database/partials"
import { isMintedGuestConversationId } from "@chatbotx.io/partysocket-config/guest-id"
import type { MessageButtonTemplate } from "@chatbotx.io/sdk"
import { createId } from "@chatbotx.io/utils"
import ky from "ky"
import { createStore } from "zustand/vanilla"
import type { CreateWebchatMessageRequest } from "@/features/messages/schema/mutation"
import type { ListMessagesResponse } from "@/features/messages/schema/query"
import type { MessageResource } from "@/features/messages/schema/resource"
import type { UserResource } from "@/features/users/schema/resource"
import { getWebchatProfileFields } from "../../browser-profile-fields"
import { isWebchatTokenDue } from "../../lib/webchat-token-expiry"
import {
  buildGuestStorageKey,
  LEGACY_GLOBAL_KEY,
  safeStorageGet,
  safeStorageRemove,
  safeStorageSet,
} from "./lib/guest-session"
import type { WebchatClientConfig } from "./lib/webchat-client-config"

export { GUEST_CONVERSATION_ID_KEY } from "./lib/guest-session"

export type GuestSessionState = {
  // default state
  guestConversationId: string | null
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
  initGuestSession: (serverGuestConversationId: string) => void

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
    /** One guest call, retried once with a refreshed token after a 403. */
    const withFreshToken = async <T>(
      call: (accessToken: string | null) => Promise<T>,
    ): Promise<T> => {
      try {
        return await call(get().accessToken)
      } catch (error) {
        const status = (error as { response?: { status?: number } } | null)
          ?.response?.status
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

      initGuestSession: (serverGuestConversationId: string) => {
        const { guestConversationId, config } = get()
        if (guestConversationId) {
          return
        }

        // The pre-s213 global key held a digits-only id that was copied into
        // every webchat on the hub origin; it is never read again.
        safeStorageRemove(LEGACY_GLOBAL_KEY)

        // A stored id is kept only in the minted form for THIS workspace; a
        // legacy digits-only or foreign id would be refused by every guest
        // route, so it is replaced by the server-minted one.
        const scopedKey = buildGuestStorageKey(config.workspaceId, config.id)
        const scopedGuestId = safeStorageGet(scopedKey)
        if (isMintedGuestConversationId(scopedGuestId, config.workspaceId)) {
          set({ guestConversationId: scopedGuestId, isNewGuestSession: false })
          return
        }

        safeStorageSet(scopedKey, serverGuestConversationId)
        set({
          guestConversationId: serverGuestConversationId,
          isNewGuestSession: true,
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

          const { data, nextCursor } = await withFreshToken((accessToken) =>
            ky
              .get<ListMessagesResponse>(
                `/api/guest/messages?${params.toString()}`,
                {
                  headers: accessToken
                    ? { Authorization: `Bearer ${accessToken}` }
                    : undefined,
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
        const { appendMessage, config, guestConversationId, parentOrigin } =
          get()

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
