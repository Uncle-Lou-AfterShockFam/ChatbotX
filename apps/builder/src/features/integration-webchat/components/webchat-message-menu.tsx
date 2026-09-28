"use client"

import {
  type WebchatPersistentMenu,
  webchatPersistentMenuType,
} from "@chatbotx.io/database/partials"
import { messageTypes } from "@chatbotx.io/sdk"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@chatbotx.io/ui/components/ui/dropdown-menu"
import { createId } from "@chatbotx.io/utils"
import { MenuIcon } from "lucide-react"
import Link from "next/link"
import { useAction } from "next-safe-action/hooks"
import { Fragment, useEffect, useRef, useState } from "react"
import { createWebchatMessageAction } from "@/features/messages/actions/create-webchat-message.action"
import { getWebchatProfileFields } from "../browser-profile-fields"
import { GUEST_SECRET_REFUSED_MESSAGE } from "../lib/guest-conversation-id"
import { useGuestSessionStore } from "../providers/store/guest-session-provider"

type WebchatMessageMenuProps = {
  workspaceId: string
  webchatId: string
  parentOrigin?: string | null
  accessToken?: string | null
}

export default function WebchatMessageMenu({
  workspaceId,
  webchatId,
  parentOrigin,
  accessToken,
}: WebchatMessageMenuProps) {
  const { getMenus } = useGuestSessionStore((state) => state)
  const [menus, setMenus] = useState<WebchatPersistentMenu[]>([])

  useEffect(() => {
    setMenus(getMenus())
  }, [getMenus])

  const {
    appendMessage,
    guestConversationId,
    guestSecret,
    freshAccessToken,
    markSendFailed,
    restartGuestSession,
  } = useGuestSessionStore((state) => state)
  const sendingRef = useRef(false)

  const { executeAsync } = useAction(createWebchatMessageAction, {
    onExecute: ({ input }) => {
      // try to push raw message to store
      if ("text" in input && input.text) {
        appendMessage({
          text: input.text as string,
          id: createId(),
          createdAt: new Date(),
          updatedAt: new Date(),
          workspaceId: "",
          // inboxId: "",
          sourceId: null,
          conversationId: "",
          contentAttributes: null,
          messageType: messageTypes.enum.incoming,
          contentType: "text",
          senderType: "contact",
          senderId: "",
          clientId: input.clientId,
        })
      }
    },
    onError: ({ error, input }) => {
      // A refused guest secret (s215): continue as a fresh conversation.
      if (error.serverError === GUEST_SECRET_REFUSED_MESSAGE) {
        restartGuestSession()
      }
      if (input.clientId) {
        markSendFailed(
          input.clientId,
          (typeof error.serverError === "string" && error.serverError) ||
            "Network error",
        )
      }
    },
  })

  return menus.length > 0 ? (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button className="size-5" size="icon" variant="ghost">
            <MenuIcon />
          </Button>
        }
      />
      <DropdownMenuContent className="w-56">
        {menus.map((menu, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: wip
          <Fragment key={index}>
            {menu.type === webchatPersistentMenuType.enum.flow && (
              <DropdownMenuItem
                onClick={async () => {
                  // A due token is refreshed first (s210); one click at a time.
                  if (sendingRef.current) {
                    return
                  }
                  sendingRef.current = true
                  // The guard covers the send itself, not just the token
                  // await, or a double click runs the flow twice (s212).
                  try {
                    const token = await freshAccessToken().catch(() => null)
                    await executeAsync({
                      flowId: menu.flowId,
                      clientId: createId(),
                      workspaceId,
                      webchatId,
                      guestConversationId: guestConversationId ?? "",
                      guestSecret: guestSecret ?? undefined,
                      ...getWebchatProfileFields(),
                      accessToken: token ?? accessToken ?? undefined,
                      parentOrigin: parentOrigin ?? undefined,
                    })
                  } finally {
                    sendingRef.current = false
                  }
                }}
              >
                {menu.label}
              </DropdownMenuItem>
            )}
            {menu.type === webchatPersistentMenuType.enum.url && (
              <DropdownMenuItem
                render={
                  <Link
                    href={menu.url}
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    {menu.label}
                  </Link>
                }
              />
            )}
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null
}
