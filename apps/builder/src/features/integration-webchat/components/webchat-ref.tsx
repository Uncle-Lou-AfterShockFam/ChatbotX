import { createId } from "@chatbotx.io/utils"
import { useSearchParams } from "next/navigation"
import { useAction } from "next-safe-action/hooks"
import { useEffect, useState } from "react"
import { createWebchatMessageAction } from "@/features/messages/actions/create-webchat-message.action"
import { getWebchatProfileFields } from "../browser-profile-fields"
import { GUEST_SECRET_REFUSED_MESSAGE } from "../lib/guest-conversation-id"
import { useGuestSessionStore } from "../providers/store/guest-session-provider"

type WebchatRefProps = {
  workspaceId: string
  webchatId: string
  guestConversationId: string
  guestSecret: string
  parentOrigin?: string | null
  accessToken?: string | null
}

export default function WebchatRef({
  workspaceId,
  webchatId,
  guestConversationId,
  guestSecret,
  parentOrigin,
  accessToken,
}: WebchatRefProps) {
  const searchParams = useSearchParams()
  const [initialized, setInitialized] = useState(false)

  const { restartGuestSession } = useGuestSessionStore((state) => state)
  // A refused guest secret (s215): continue as a fresh conversation, whose
  // remounted WebchatRef runs init again.
  const { execute } = useAction(createWebchatMessageAction, {
    onError: ({ error }) => {
      if (error.serverError === GUEST_SECRET_REFUSED_MESSAGE) {
        restartGuestSession()
      }
    },
  })

  useEffect(() => {
    if (initialized || !(guestConversationId && guestSecret)) {
      return
    }

    setInitialized(true)
    const ref = searchParams.get("ref")
    execute({
      clientId: createId(),
      workspaceId,
      webchatId,
      guestConversationId,
      guestSecret,
      ...(ref ? { initRef: ref } : { init: true }),
      ...getWebchatProfileFields(),
      accessToken: accessToken ?? undefined,
      parentOrigin: parentOrigin ?? undefined,
    })
  }, [
    searchParams,
    initialized,
    execute,
    workspaceId,
    webchatId,
    guestConversationId,
    guestSecret,
    parentOrigin,
    accessToken,
  ])

  return null
}
