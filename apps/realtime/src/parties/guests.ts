import { isMintedGuestConversationId } from "@chatbotx.io/partysocket-config/guest-id"
import type * as Party from "partykit/server"
import { env } from "../env"
import { verifyBroadcastRequest } from "../lib/realtime-auth"

export default class GuestConversationParty implements Party.Server {
  // biome-ignore lint/style/noParameterProperties: wip
  constructor(readonly room: Party.Room) {}

  async onRequest(req: Party.Request) {
    const payload = await req.json()
    this.room.broadcast(JSON.stringify(payload))

    return new Response("ok", { status: 200 })
  }

  // The room name is the guest conversation id, the conversation's only
  // credential (connect-time token auth adds no secret, s212). Only the minted
  // `<workspaceId>:<uuid>` form is a room: a guessable digits-only name is
  // refused before any socket opens (s213).
  static onBeforeConnect(req: Party.Request, lobby: Party.Lobby) {
    if (!isMintedGuestConversationId(lobby.id)) {
      return new Response("Access denied", { status: 403 })
    }
    return req
  }

  static async onBeforeRequest(
    req: Party.Request,
    // lobby: Party.Lobby,
    // ctx: Party.ExecutionContext
  ) {
    const error = await verifyBroadcastRequest(
      req,
      "guest",
      env.REALTIME_BROADCAST_SECRET as string,
    )
    return error ?? req
  }
}
