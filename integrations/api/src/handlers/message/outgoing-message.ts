import { apiChannelOutboxService } from "@chatbotx.io/business"
import { bulktextSendOptions, stepTypes } from "@chatbotx.io/flow-config"
import {
  contentTypes,
  type MessageHandlers,
  type ReceivedMessageResult,
  type SendFlowStepData,
} from "@chatbotx.io/sdk"
import { z } from "zod"
import { postSignedEnvelope } from "../../lib/delivery"
import { logger } from "../../lib/logger"
import { shortenEnvelopeLinks } from "../../lib/short-links"
import type { ApiAuthValue } from "../../schema"

// The queue contract (`IntegrationJobMessageStatus`) and the public
// `delivery-status` route both name the message id `messageId`; this schema
// must agree with them or every accepted (204) status dies here as a
// ZodError. The recipient identity is REQUIRED: the worker resolves the
// conversation from `contact.sourceId` and refuses an empty identity by
// design, so a status without one can never be recorded.
const messageStatusPayloadSchema = z.object({
  messageId: z.string().min(1),
  status: z.string(),
  contact: z.object({ sourceId: z.string().min(1) }),
})

/**
 * A bulktext line worker answers a send request it will NOT queue with a
 * 200 and a non-null `reason` (`bad-options`, `duplicate`, `own-line`,
 * `media-fetch`, `suppressed`...). Only `suppressed` also comes back later
 * as an async `failed` status (it has a `hook:<id>` message id); every other
 * refusal has no message id and would otherwise read as "sent" (skeptic
 * s163). Throwing here lands in the chat sender's catch: `message:failed`
 * with this text, terminal, visible in the inbox.
 */
const assertNotRefused = (
  response: { messageId?: string; reason?: unknown; warning?: unknown } | null,
): void => {
  if (typeof response?.reason !== "string" || response.reason === "") {
    return
  }
  if (response.reason === "suppressed" && response.messageId) {
    return
  }
  const warning =
    typeof response.warning === "string" && response.warning !== ""
      ? `: ${response.warning}`
      : ""
  throw new Error(`bulktext refused the send (${response.reason})${warning}`)
}

/**
 * Pull mode (fork, s164): the envelope is queued for the inbox's worker
 * instead of POSTed. The queued row's id becomes the message's channel id
 * (`outbox:<id>`), which is what the worker later names in its delivery
 * statuses; a refusal arrives asynchronously through the ack route.
 */
const isPullMode = (ctx: { auth: ApiAuthValue }): boolean =>
  ctx.auth.deliveryMode === "pull"

const enqueueForPull = async (
  ctx: { auth: ApiAuthValue; integrationDetail?: Record<string, unknown> },
  contactSourceId: string,
  envelope: { [x: string]: unknown },
): Promise<{ messageIds: string[] }> => {
  const inboxId = ctx.integrationDetail?.inboxId
  const workspaceId = ctx.integrationDetail?.workspaceId
  if (typeof inboxId !== "string" || typeof workspaceId !== "string") {
    throw new Error(
      "pull mode: the integration row carries no inbox / workspace id",
    )
  }
  if (contactSourceId === "") {
    throw new Error(
      "pull mode: the contact has no channel identity (contact.sourceId)",
    )
  }
  const id = await apiChannelOutboxService.enqueue({
    workspaceId,
    inboxId,
    contactSourceId,
    envelope,
  })
  return { messageIds: [`outbox:${id}`] }
}

export const sendMessage: MessageHandlers<ApiAuthValue>["sendMessage"] = async (
  props,
) => {
  const {
    ctx,
    data: { contact, message, quickReplies },
  } = props

  const envelope = await shortenEnvelopeLinks({
    ctx,
    contact,
    envelope: {
      event: "message_created",
      timestamp: new Date().toISOString(),
      contact: { id: contact.id, sourceId: contact.sourceId },
      conversation: { id: message.conversationId },
      message: {
        id: message.id,
        text: message.text,
        messageType: message.messageType,
        contentType: message.contentType,
        attachments: message.attachments,
        contentAttributes: message.contentAttributes,
        quickReplies,
      },
    },
  })

  if (isPullMode(ctx)) {
    return enqueueForPull(ctx, contact.sourceId, envelope)
  }

  if (!ctx.auth.callbackUrl) {
    // Inbound-only channels (no callback URL configured) are valid, not an error.
    return { messageIds: [] }
  }

  const response = await postSignedEnvelope({
    callbackUrl: ctx.auth.callbackUrl,
    signingSecret: ctx.auth.signingSecret,
    envelope,
  })

  assertNotRefused(response)
  return { messageIds: response?.messageId ? [response.messageId] : [] }
}

/**
 * Full rich parity is the point of this channel — unlike webchat, which
 * no-ops `sendFlowStep` entirely, every flow step variant is mapped onto the
 * same envelope shape as `sendMessage`, with `contentAttributes` carrying the
 * rich payload. Unsupported step types degrade to their text content.
 */
export const sendFlowStep: MessageHandlers<ApiAuthValue>["sendFlowStep"] =
  async (props) => {
    const {
      ctx,
      data: { contact, flowId, step, quickReplies },
    } = props

    const { text, contentAttributes } = mapFlowStepToEnvelope(step)
    const envelope = await shortenEnvelopeLinks({
      ctx,
      contact,
      flowId,
      stepId: step.id,
      envelope: {
        event: "message_created",
        timestamp: new Date().toISOString(),
        contact: { id: contact.id, sourceId: contact.sourceId },
        message: {
          text,
          messageType: "outgoing",
          contentType: contentTypes.enum.text,
          contentAttributes,
          quickReplies,
        },
      },
    })

    if (isPullMode(ctx)) {
      return enqueueForPull(ctx, contact.sourceId, envelope)
    }

    if (!ctx.auth.callbackUrl) {
      return { messageIds: [] }
    }

    const response = await postSignedEnvelope({
      callbackUrl: ctx.auth.callbackUrl,
      signingSecret: ctx.auth.signingSecret,
      envelope,
    })

    assertNotRefused(response)
    return { messageIds: response?.messageId ? [response.messageId] : [] }
  }

const fileTypeForStep = (
  stepType: SendFlowStepData["stepType"],
): "image" | "audio" | "video" | "file" => {
  switch (stepType) {
    case stepTypes.enum.sendImage:
    case stepTypes.enum.sendGif:
      return "image"
    case stepTypes.enum.sendAudio:
      return "audio"
    case stepTypes.enum.sendVideo:
      return "video"
    default:
      return "file"
  }
}

const mapFlowStepToEnvelope = (
  step: SendFlowStepData,
): { text: string | null; contentAttributes?: Record<string, unknown> } => {
  switch (step.stepType) {
    case stepTypes.enum.sendText:
      return { text: step.text }
    case stepTypes.enum.sendImage:
    case stepTypes.enum.sendGif:
    case stepTypes.enum.sendVideo:
    case stepTypes.enum.sendAudio:
    case stepTypes.enum.sendFile:
      return {
        text: null,
        contentAttributes: {
          attachments: [
            { url: step.url, fileType: fileTypeForStep(step.stepType) },
          ],
        },
      }
    case stepTypes.enum.sendMultipleImages:
      return {
        text: null,
        contentAttributes: {
          attachments: step.images.map((image) => ({
            url: image.url,
            fileType: "image" as const,
          })),
        },
      }
    case stepTypes.enum.sendQuickReply:
      return { text: step.message }
    // "Text via bulktext": the line worker reads its delivery options from
    // `contentAttributes.bulktext`; a photo rides as an ordinary attachment.
    case stepTypes.enum.bulktextSend:
      return {
        text: step.text === "" ? null : step.text,
        contentAttributes: {
          ...(step.photoUrl === ""
            ? {}
            : { attachments: [{ url: step.photoUrl, fileType: "image" }] }),
          bulktext: bulktextSendOptions(step),
        },
      }
    case stepTypes.enum.sendCarousel:
      return {
        text: null,
        contentAttributes: {
          type: "template",
          payload: {
            templateType: "carousel",
            cards: step.cards.map((card) => ({
              id: card.id,
              title: card.title,
              subtitle: card.subtitle,
              imageUrl: card.image?.url,
              buttons: card.buttons,
            })),
          },
        },
      }
    default:
      logger.warn(
        { stepType: step.stepType },
        "API channel: unsupported flow step type, degrading to text",
      )
      return {
        text:
          "text" in step && typeof step.text === "string" ? step.text : null,
      }
  }
}

export const handleMessageStatus: NonNullable<
  MessageHandlers<ApiAuthValue>["handleMessageStatus"]
> = ({ data }): Promise<ReceivedMessageResult | null> => {
  const validated = messageStatusPayloadSchema.parse(data.payload)

  return Promise.resolve({
    message: {
      sourceId: validated.messageId,
      messageType: "outgoing",
      contentType: contentTypes.enum.text,
      contentAttributes: { deliveryStatus: validated.status },
    },
    contact: { sourceId: validated.contact.sourceId },
    postbackAction: null,
    quickReplyAction: null,
    ref: null,
  })
}
