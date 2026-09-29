import { z } from "zod"
import { actionSteps } from "../shared"
import { askFormStepSchema } from "../steps/ask-form"
import { bulktextSendStepSchema } from "../steps/bulktext-send"
import { buttonStepSchema } from "../steps/button"
import {
  chooseChannelStepDefaultFn,
  chooseChannelStepSchema,
} from "../steps/choose-channel"
import { getUserDataStepSchema } from "../steps/get-user-data"
import { sendAudioStepSchema } from "../steps/send-audio"
import { sendCarouselStepSchema } from "../steps/send-carousel"
import { sendFileStepSchema } from "../steps/send-file"
import { sendGifStepSchema } from "../steps/send-gif"
import { sendImageStepSchema } from "../steps/send-image"
import { sendMessengerTemplateMessageStepSchema } from "../steps/send-messenger-message-template"
import { sendMultipleImagesStepSchema } from "../steps/send-multiple-images"
import { MAX_QUICK_REPLIES } from "../steps/send-quick-reply"
import { sendTextStepSchema } from "../steps/send-text"
import { sendVideoStepSchema } from "../steps/send-video"
import { sendWaTemplateMessageStepSchema } from "../steps/send-wa-message-template"
import { typingStepSchema } from "../steps/typing"
import { whatsappCallButtonStepSchema } from "../steps/whatsapp-call-button"
import { whatsappFlowStepSchema } from "../steps/whatsapp-flow"
import { whatsappOptionListStepSchema } from "../steps/whatsapp-option-list"
import {
  baseNodeDataSchema,
  baseNodeSchema,
  type DefaultNodeProps,
  defaultNodeData,
  nodeTypeSchema,
} from "./base"

export const sendMessageNodeSchema = baseNodeSchema.extend({
  type: z.literal(nodeTypeSchema.enum.sendMessage),
  data: baseNodeDataSchema.extend({
    details: z.object({
      beforeStep: chooseChannelStepSchema,
      steps: z.array(
        z.discriminatedUnion("stepType", [
          sendAudioStepSchema,
          sendFileStepSchema,
          sendImageStepSchema,
          sendMultipleImagesStepSchema,
          sendTextStepSchema,
          bulktextSendStepSchema,
          sendVideoStepSchema,
          // sendCardStepSchema,
          sendCarouselStepSchema,
          getUserDataStepSchema,
          askFormStepSchema,
          sendGifStepSchema,
          typingStepSchema,
          sendWaTemplateMessageStepSchema,
          sendMessengerTemplateMessageStepSchema,
          whatsappOptionListStepSchema,
          whatsappCallButtonStepSchema,
          whatsappFlowStepSchema,
          ...actionSteps,
        ]),
      ),
      quickReplies: z.array(buttonStepSchema).max(MAX_QUICK_REPLIES),
    }),
  }),
})
export type SendMessageNodeSchema = z.infer<typeof sendMessageNodeSchema>

export const sendMessageNodeDefaultFn = (
  props: DefaultNodeProps,
): SendMessageNodeSchema => ({
  ...defaultNodeData(),
  type: nodeTypeSchema.enum.sendMessage,
  ...props.nodeProps,
  data: {
    name: "Send Message",
    isStartNode: false,
    ...props.dataProps,
    details: {
      beforeStep: chooseChannelStepDefaultFn(),
      steps: [],
      quickReplies: [],
      ...props.detailProps,
    },
  },
})

export const BROADCAST_PAYLOAD_TYPE = "broadcast"
export const SEQUENCE_SCHEDULE_PAYLOAD_TYPE = "sequenceSchedule"
export const COMMENT_AUTOMATION_PAYLOAD_TYPE = "commentAutomation"
export const UPDATE_STATUS_PAYLOAD_TYPE = "updateStatus"
export const FLOW_NODE_PAYLOAD_TYPE = "flowNode"
export const APPOINTMENT_WEBVIEW_SELECTION_PAYLOAD_TYPE =
  "appointmentWebviewSelection"
export const APPOINTMENT_AVAILABILITY_RANGE_SELECTION_PAYLOAD_TYPE =
  "appointmentAvailabilityRangeSelection"
export const APPOINTMENT_AVAILABILITY_RANGE_SKIPPED_PAYLOAD_TYPE =
  "appointmentAvailabilityRangeSkipped"
export const GET_USER_DATA_WEBVIEW_SELECTION_PAYLOAD_TYPE =
  "getUserDataWebviewSelection"
export const ASK_FORM_EXPIRED_PAYLOAD_TYPE = "askFormExpired"

export const baseMetadataPayload = z.object({
  stepId: z.string().optional(),
  contactInboxId: z.string().optional(),
})
export type BaseMetadataPayload = z.infer<typeof baseMetadataPayload>

export const broadcastMetadataPayload = baseMetadataPayload.extend({
  type: z.literal(BROADCAST_PAYLOAD_TYPE),
  broadcastId: z.string(),
  contactInboxId: z.string(),
})

export const sequenceScheduleMetadataPayload = baseMetadataPayload.extend({
  type: z.literal(SEQUENCE_SCHEDULE_PAYLOAD_TYPE),
  sequenceStepId: z.string(),
  sequenceId: z.string(),
  dispatchId: z.string(),
  contactInboxId: z.string(),
})

/**
 * Set on the `sendFlow` job when a comment automation answers with a `flow`
 * reply, so the buttons that flow sends can be attributed back to the
 * automation when the contact taps one.
 *
 * This rides in `metadata` rather than on `CommentAnchor`, even though the
 * anchor already names the automation, because the anchor never reaches the
 * code that encodes the button payload: `sendFlowStep` hands the channel the
 * RAW step and each integration re-encodes from it, seeing only `metadata`.
 * The anchor is also dropped for non-message steps, withheld from
 * `instagramFacebook`, and lost across a Wait — while `metadata` survives all
 * three (`ContactOnSmartDelay.metadata` is a real column).
 *
 * `commentAutomationId` must keep that exact name: `extractMetadata` is a bare
 * `metadata[key]` lookup, and the channel encoders read it by that key.
 */
export const commentAutomationMetadataPayload = baseMetadataPayload.extend({
  type: z.literal(COMMENT_AUTOMATION_PAYLOAD_TYPE),
  commentAutomationId: z.string(),
  commentId: z.string(),
  replyChannel: z.enum(["public", "private"]),
})

export const updateStatusPayload = baseMetadataPayload.extend({
  type: z.literal(UPDATE_STATUS_PAYLOAD_TYPE),
})

export const appointmentWebviewSelectionPayload = baseMetadataPayload.extend({
  type: z.literal(APPOINTMENT_WEBVIEW_SELECTION_PAYLOAD_TYPE),
  stepId: z.string(),
  selectedStartAt: z.iso.datetime(),
  appointmentId: z.string().optional(),
})

export const appointmentAvailabilityRangeSelectionPayload =
  baseMetadataPayload.extend({
    type: z.literal(APPOINTMENT_AVAILABILITY_RANGE_SELECTION_PAYLOAD_TYPE),
    stepId: z.string(),
    startDate: z.iso.datetime({ local: true }),
    endDate: z.iso.datetime({ local: true }),
  })

export const appointmentAvailabilityRangeSkippedPayload =
  baseMetadataPayload.extend({
    type: z.literal(APPOINTMENT_AVAILABILITY_RANGE_SKIPPED_PAYLOAD_TYPE),
    stepId: z.string(),
  })

export const getUserDataWebviewSelectionPayload = baseMetadataPayload.extend({
  type: z.literal(GET_USER_DATA_WEBVIEW_SELECTION_PAYLOAD_TYPE),
  stepId: z.string(),
  challengeId: z.string(),
  selectedValue: z.iso.datetime(),
})

/**
 * The form-run expiry sweep re-enters the flow at the askForm step with this
 * marker, so the step routes its `skip` state through the normal machinery
 * (s219 A2-2). The step acts on it only while that run is still `expired`.
 */
export const askFormExpiredPayload = baseMetadataPayload.extend({
  type: z.literal(ASK_FORM_EXPIRED_PAYLOAD_TYPE),
  stepId: z.string(),
  formSessionId: z.string(),
})
export type AskFormExpiredPayload = z.infer<typeof askFormExpiredPayload>

export type BroadcastMetadataPayload = z.infer<typeof broadcastMetadataPayload>

export type SequenceScheduleMetadataPayload = z.infer<
  typeof sequenceScheduleMetadataPayload
>

export type CommentAutomationMetadataPayload = z.infer<
  typeof commentAutomationMetadataPayload
>

export const metadataSchema = z.discriminatedUnion("type", [
  broadcastMetadataPayload,
  sequenceScheduleMetadataPayload,
  commentAutomationMetadataPayload,
  updateStatusPayload,
  appointmentWebviewSelectionPayload,
  appointmentAvailabilityRangeSelectionPayload,
  appointmentAvailabilityRangeSkippedPayload,
  getUserDataWebviewSelectionPayload,
  askFormExpiredPayload,
])

export type MetadataPayload = z.infer<typeof metadataSchema>

export type GetUserDataWebviewSelectionPayload = z.infer<
  typeof getUserDataWebviewSelectionPayload
>
