"use client"

import {
  type RealtimeEventData,
  RealtimeEventType,
} from "@chatbotx.io/partysocket-config"
import usePartySocket from "partysocket/react"
import type { MessageResource } from "../messages/schema/resource"
import { useTenantSettings } from "../tenant"
import { useGuestSessionStore } from "./providers/store/guest-session-provider"

type WebchatRealtimeProps = {
  guestConversationId: string
  guestSecret: string
}

export function WebchatRealtime({
  guestConversationId,
  guestSecret,
}: WebchatRealtimeProps) {
  const { wsUrl } = useTenantSettings()
  const { handleNewMessage, setIsTyping } = useGuestSessionStore(
    (state) => state,
  )

  usePartySocket({
    host: wsUrl,
    room: guestConversationId,
    party: "guests",
    // The room is the id, which the API and exports show; the secret is what
    // lets this visitor in (s215). A query param: a socket cannot send headers.
    query: { k: guestSecret },

    // onOpen() {},
    onMessage(e) {
      try {
        const { eventType, data } = JSON.parse(e.data) as RealtimeEventData
        switch (eventType) {
          case RealtimeEventType.messageCreated: {
            const message = data as MessageResource
            handleNewMessage(message)
            // The worker only ever sends `typing: true`; clear the indicator
            // once the bot reply itself arrives so the dots don't stay forever.
            if (message.messageType === "outgoing") {
              setIsTyping(false)
            }
            break
          }
          case RealtimeEventType.typing:
            setIsTyping(data.typing)
            break
          default:
            break
        }
      } catch (error) {
        console.error("Unable to parse realtime message", error)
      }
    },
    // onClose() {},
    // onError() {},
  })

  return <div />
}
