"use client"

import type { CSSProperties } from "react"
import WebchatRef from "./components/webchat-ref"
import { readableForeground } from "./lib/brand-color"
import { useGuestSessionStore } from "./providers/store/guest-session-provider"
import { WebchatHeader } from "./webchat-header"
import { WebchatMessageInput } from "./webchat-message-input"
import { WebchatMessageList } from "./webchat-message-list"
import { WebchatRealtime } from "./webchat-realtime"

export const WebchatWrapper = ({ referral }: { referral?: string }) => {
  // `parentOrigin` comes from the store, frozen at mount beside the token it
  // was minted with: a later server re-render (TimezoneSync's refresh on a
  // top-level open) carries the hub as Referer and must not change it (s209).
  const { guestConversationId, accessToken, config, parentOrigin } =
    useGuestSessionStore((state) => state)

  const brandColorStyle = {
    "--primary": config.brandColor,
    "--primary-foreground": readableForeground(config.brandColor),
  } as CSSProperties

  return (
    <div className="flex h-screen w-screen flex-col" style={brandColorStyle}>
      {!config.hideHeader && <WebchatHeader />}
      <WebchatMessageList />
      {!config.hideMessageInput && (
        <WebchatMessageInput
          accessToken={accessToken}
          parentOrigin={parentOrigin}
          referral={referral}
          webchatId={config.id}
          workspaceId={config.workspaceId}
        />
      )}
      <WebchatRef
        accessToken={accessToken}
        guestConversationId={guestConversationId ?? ""}
        parentOrigin={parentOrigin}
        webchatId={config.id}
        workspaceId={config.workspaceId}
      />
      {!!guestConversationId && (
        <WebchatRealtime guestConversationId={guestConversationId} />
      )}
    </div>
  )
}
