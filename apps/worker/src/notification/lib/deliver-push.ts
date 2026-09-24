import { deviceTokenService } from "@chatbotx.io/business"
import { Expo, type ExpoPushMessage, type ExpoPushToken } from "expo-server-sdk"
import { logger } from "../../lib/logger"

/**
 * The delivery half shared by every push job: tokens of the recipients,
 * malformed tokens pruned, chunked Expo send, `DeviceNotRegistered` tickets
 * pruned, and a throw ONLY when every chunk failed (BullMQ retries; a
 * partial failure stays isolated per chunk).
 */
export const deliverPushToUsers = async (props: {
  expo: Expo
  userIds: string[]
  title: string
  body: string
  data: Record<string, unknown>
}): Promise<{ sent: number }> => {
  const { expo, userIds, title, body, data } = props
  if (userIds.length === 0) {
    return { sent: 0 }
  }

  const deviceTokens = await deviceTokenService.findByUserIds({ userIds })
  if (deviceTokens.length === 0) {
    return { sent: 0 }
  }

  const validTokens: ExpoPushToken[] = []
  const invalidTokens: string[] = []
  for (const deviceToken of deviceTokens) {
    if (Expo.isExpoPushToken(deviceToken.token)) {
      validTokens.push(deviceToken.token)
    } else {
      invalidTokens.push(deviceToken.token)
    }
  }

  if (invalidTokens.length > 0) {
    await deviceTokenService.deleteByTokens({ tokens: invalidTokens })
  }

  if (validTokens.length === 0) {
    return { sent: 0 }
  }

  const messages: ExpoPushMessage[] = validTokens.map((token) => ({
    to: token,
    title,
    body,
    data,
    sound: "default",
    channelId: "default",
    priority: "high",
  }))

  const chunks = expo.chunkPushNotifications(messages)
  const staleTokens: string[] = []
  let failedChunkCount = 0

  for (const chunk of chunks) {
    try {
      const tickets = await expo.sendPushNotificationsAsync(chunk)
      for (const [index, ticket] of tickets.entries()) {
        if (ticket.status === "error") {
          logger.info(
            { error: ticket.details?.error, message: ticket.message },
            "Expo push ticket error",
          )
        }
        if (
          ticket.status === "error" &&
          ticket.details?.error === "DeviceNotRegistered"
        ) {
          const sentMessage = chunk[index]
          if (typeof sentMessage.to === "string") {
            staleTokens.push(sentMessage.to)
          }
        }
      }
    } catch (error) {
      failedChunkCount++
      logger.warn(error, "Expo push chunk failed")
    }
  }

  // If every chunk threw, nothing was delivered — rethrow so BullMQ retries
  // instead of silently dropping the notification. Partial failures stay
  // isolated per-chunk above.
  if (failedChunkCount === chunks.length) {
    throw new Error(`All ${chunks.length} Expo push chunk(s) failed to send`)
  }

  if (staleTokens.length > 0) {
    await deviceTokenService.deleteByTokens({ tokens: staleTokens })
    logger.info(
      { count: staleTokens.length },
      "pruned stale device push tokens",
    )
  }
  return { sent: validTokens.length }
}
