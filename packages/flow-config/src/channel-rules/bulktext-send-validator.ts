import { channelTypes } from "@chatbotx.io/utils/channel"
import { bulktextSendStepSchema } from "../steps/bulktext-send"
import type { ChannelValidatorMap } from "./channel-validator"

/**
 * React-free (reached from the publish schema and the worker's import
 * validation). "Text via bulktext" only means something on an API-channel
 * inbox served by a bulktext line worker: on every other channel the node
 * refuses to publish instead of persisting a phantom outgoing message.
 */
export const bulktextSendValidator = {
  [channelTypes.enum.omnichannel]: bulktextSendStepSchema.superRefine(
    (_step, ctx) => {
      ctx.addIssue({
        code: "custom",
        message:
          "Text via bulktext sends only through an API channel inbox: set the node's channel to API",
      })
    },
  ),
  [channelTypes.enum.api]: bulktextSendStepSchema,
} satisfies ChannelValidatorMap
