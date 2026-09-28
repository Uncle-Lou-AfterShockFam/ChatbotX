import { createId } from "@chatbotx.io/utils"
import { useSearchParams } from "next/navigation"
import { useAction } from "next-safe-action/hooks"
import { useEffect, useState } from "react"
import { createWebchatMessageAction } from "@/features/messages/actions/create-webchat-message.action"
import { getWebchatProfileFields } from "../browser-profile-fields"

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

  const { execute } = useAction(createWebchatMessageAction)

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
