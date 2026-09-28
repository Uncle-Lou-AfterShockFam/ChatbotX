import { isMintedGuestConversationId } from "@chatbotx.io/partysocket-config/guest-id"
import { verifyGuestSecret } from "@chatbotx.io/partysocket-config/guest-secret"
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

  // The room name is the guest conversation id, which the API and exports
  // show, so it is no credential (s215). The visitor proves the room is theirs
  // with the guest secret minted beside the id, sent as `?k=` (a socket cannot
  // send headers). Only the minted `<workspaceId>:<uuid>` form is a room
  // (s213); both checks run before any socket opens.
  static async onBeforeConnect(req: Party.Request, lobby: Party.Lobby) {
    const secret = new URL(req.url).searchParams.get("k")
    const valid =
      isMintedGuestConversationId(lobby.id) &&
      (await verifyGuestSecret(lobby.id, secret, env.REALTIME_BROADCAST_SECRET))
    if (!valid) {
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
