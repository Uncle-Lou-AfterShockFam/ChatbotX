import {
  conversationService,
  normalizeLanguage,
  resolveTenantSettings,
  workspaceService,
} from "@chatbotx.io/business"
import {
  type FormChatAction,
  formSessionService,
  type ReplacedRun,
} from "@chatbotx.io/business/form"
import { validateReplyInput } from "@chatbotx.io/business/get-user-data"
import { getPublicFileUrl } from "@chatbotx.io/business/utils"
import type {
  ConversationAttributes,
  FormField,
} from "@chatbotx.io/database/partials"
import {
  createMessageRepository,
  getSafeSinceTime,
  type MessageWithAttachments,
} from "@chatbotx.io/database/repositories"
import type { FormSessionModel } from "@chatbotx.io/database/types"
import { signUserDataWebviewToken } from "@chatbotx.io/encryption"
import {
  ASK_FORM_EXPIRED_PAYLOAD_TYPE,
  type AskFormStepSchema,
  BUTTON_LABEL_MAX,
  GET_USER_DATA_WEBVIEW_SELECTION_PAYLOAD_TYPE,
  MAX_QUICK_REPLIES,
  ReplyFormat,
} from "@chatbotx.io/flow-config"
import {
  type MessageButtonTemplate,
  NATIVE_LOCATION_REQUEST_CHANNELS,
  URL_QUICK_REPLY_CAPABLE_CHANNELS,
  WHATSAPP_NATIVE_LOCATION_REQUEST,
} from "@chatbotx.io/sdk"
import {
  FORM_CHAT_SKIP_WORD,
  FORM_SCALE_FIELD_TYPES,
  formChatPayload,
  formOptionsNumbered,
  formScaleBounds,
  isFormChatSkip,
} from "@chatbotx.io/utils/form"
import { ChatJobAction, chatQueue } from "@chatbotx.io/worker-config"
import { normalizeError } from "universal-error-normalizer"
import { logger } from "../../lib/logger"
import {
  QUICK_REPLY_CHANNELS,
  waitForChatJobCompletion,
  waitForChatJobDelivered,
} from "../utils/message"
import type { ExecuteStepProps } from "./flow-utils"
import type { ExecuteStepResult } from "./step"

/**
 * The `askForm` step (s219 A2-2): runs a published form in the conversation,
 * one question per message. All state lives in the FormSession row
 * (formSessionService); this handler turns a service action into messages
 * and a step status:
 *   - first entry: start (or resume) the run and ask;
 *   - challenge resume (the contact replied): answer with THAT message;
 *   - date picker submit: answer with the picked value, keyed by challengeId;
 *   - expiry re-entry (the sweep): route `skip` once for an expired run.
 * `success` = submitted, `skip` = unavailable / attempts exhausted / expired.
 */

type Props = ExecuteStepProps<AskFormStepSchema>

const DEFAULT_RETRY = "Sorry, that answer doesn't fit. Please try again."
const MESSAGE_LOOKBACK_MS = 365 * 24 * 60 * 60 * 1000

const WEBVIEW_COPY = {
  en: {
    selectDate: "Select Date",
    skip: "Skip",
    sendLocation: "Send location",
  },
  vi: { selectDate: "Chọn ngày", skip: "Bỏ qua", sendLocation: "Gửi vị trí" },
}

/** The reply formats whose message the get-user-data validators understand. */
const REPLY_FORMAT_BY_TYPE: Partial<Record<FormField["type"], ReplyFormat>> = {
  image: ReplyFormat.image,
  file: ReplyFormat.file,
  location: ReplyFormat.location,
  date: ReplyFormat.date,
  datetime: ReplyFormat.datetime,
}

export async function askForm(props: Props): Promise<ExecuteStepResult> {
  const { ctx, metadata, step } = props
  // Metadata rides into every later step and node; it is ours only on the
  // job that re-entered THIS step (a flow looping back here starts fresh).
  const reentry = props.startFromStepId === step.id
  try {
    if (
      reentry &&
      metadata?.type === ASK_FORM_EXPIRED_PAYLOAD_TYPE &&
      metadata.stepId === step.id
    ) {
      return await routeExpired(props, metadata.formSessionId)
    }
    if (
      reentry &&
      metadata?.type === GET_USER_DATA_WEBVIEW_SELECTION_PAYLOAD_TYPE &&
      metadata.stepId === step.id
    ) {
      const value =
        typeof metadata.selectedValue === "string"
          ? metadata.selectedValue
          : null
      return await perform(
        props,
        await formSessionService.answer({
          workspaceId: props.conversation.workspaceId,
          contactId: props.conversation.contactId,
          conversationId: props.conversation.id,
          contactInboxId: props.contactInbox.id,
          stepId: step.id,
          reply: { challengeId: metadata.challengeId, text: value },
        }),
      )
    }
    if (ctx?.variables.conversation.challengeAttempts) {
      return await answerFromMessage(props)
    }
    return await perform(
      props,
      await formSessionService.start({
        workspaceId: props.conversation.workspaceId,
        formId: step.formId,
        contactId: props.conversation.contactId,
        conversationId: props.conversation.id,
        contactInboxId: props.contactInbox.id,
        flowId: props.flowVersion.flowId,
        flowVersionId: props.useLatestFlowVersion ? null : props.flowVersion.id,
        nodeId: challengeNodeId(props),
        stepId: step.id,
        runStartedAt: props.runStartedAt ?? null,
        timeoutMinutes: step.timeoutMinutes,
        maxAttempts: step.maxAttempts,
      }),
    )
  } catch (error) {
    logger.error(
      {
        err: normalizeError(error),
        conversationId: props.conversation.id,
        stepId: step.id,
        formId: step.formId,
      },
      "askForm: step failed",
    )
    // A throw here would retry the whole job and re-send the question; the
    // run row keeps its state, so the next reply (or the sweep) continues.
    return { status: "wait", result: null }
  }
}

/** The contact replied: answer with the message that resumed the challenge. */
async function answerFromMessage(props: Props): Promise<ExecuteStepResult> {
  const message = await loadReply(props)
  if (!message) {
    return { status: "wait", result: null }
  }
  return await perform(
    props,
    await formSessionService.answer({
      workspaceId: props.conversation.workspaceId,
      contactId: props.conversation.contactId,
      conversationId: props.conversation.id,
      contactInboxId: message.contactInboxId ?? props.contactInbox.id,
      stepId: props.step.id,
      reply: {
        messageId: message.id,
        read: (field) => replyText(props, field, message),
      },
    }),
  )
}

/**
 * The resuming message: the challenge job names it; webchat enqueues without
 * a message id, so it falls back to the newest incoming message (the
 * service's askMarker still refuses one older than the question).
 */
async function loadReply(props: Props): Promise<MessageWithAttachments | null> {
  const repository = await createMessageRepository()
  const workspaceId = props.conversation.workspaceId
  if (props.triggerMessageId && props.triggerMessageCreatedAt) {
    const message = await repository.findById({
      id: props.triggerMessageId,
      createdAt: props.triggerMessageCreatedAt,
      workspaceId,
    })
    if (
      message?.conversationId === props.conversation.id &&
      message.messageType === "incoming"
    ) {
      return message
    }
    return null
  }
  const [latest] = await repository.findLastByConversation(
    props.conversation.id,
    {
      workspaceId,
      messageTypes: ["incoming"],
      limit: 1,
      requireCompleteResults: true,
      withAttachments: true,
      sinceTime: getSafeSinceTime(
        props.conversation.lastActivityAt ?? props.conversation.createdAt,
        MESSAGE_LOOKBACK_MS,
      ),
    },
  )
  return latest ?? null
}

/**
 * The reply as the form answer text: a photo / file becomes its public URL,
 * a shared location "lat,lng", a date its ISO day; anything else is the typed
 * text. A reply that does not fit the format is null (the service re-asks).
 */
async function replyText(
  props: Props,
  field: FormField,
  message: MessageWithAttachments,
): Promise<string | null> {
  const format = REPLY_FORMAT_BY_TYPE[field.type]
  if (!format) {
    return message.text ?? null
  }
  if (message.text && isFormChatSkip(message.text)) {
    return message.text
  }
  const result = validateReplyInput(format, message)
  if (!result.ok) {
    return null
  }
  if (result.kind === "attachment") {
    const { storageUrl } = await resolveTenantSettings({
      workspaceId: props.conversation.workspaceId,
    })
    return getPublicFileUrl(result.userInput, storageUrl)
  }
  if (field.type === "location") {
    return result.userInput.replace(/\s+/g, "")
  }
  return field.type === "date"
    ? result.userInput.slice(0, 10)
    : result.userInput
}

/** Turn a service action into messages, the challenge and a step status. */
async function perform(
  props: Props,
  action: FormChatAction,
): Promise<ExecuteStepResult> {
  switch (action.kind) {
    case "ask":
      await clearReplaced(props, action.replaced)
      await sendPreface(props, action.preface)
      await ask(props, action.session, action.field, action.retry)
      return { status: action.retry ? "retry" : "wait", result: null }
    case "completed":
      await clearReplaced(props, action.replaced)
      await clearChallenge(props, action.session)
      await sendPreface(props, action.preface)
      return { status: "success", result: action.submission.id }
    case "ended":
      await clearChallenge(props, action.session)
      return { status: "skip", result: action.reason }
    case "unavailable":
      logger.info(
        { conversationId: props.conversation.id, formId: props.step.formId },
        `askForm: ${action.reason}`,
      )
      return action.reason === "busy"
        ? { status: "wait", result: null }
        : { status: "skip", result: action.reason }
    default:
      // ignored: a duplicate / stale reply, or no run for this step. Nothing
      // is sent; the current question (if any) stays open.
      logger.info(
        {
          conversationId: props.conversation.id,
          stepId: props.step.id,
          reason: action.reason,
        },
        "askForm: reply ignored",
      )
      return { status: "wait", result: null }
  }
}

/**
 * The sweep ended this run: route `skip` ONCE (claimExpiredRoute), never
 * when the contact already has a newer run (skip + success in one flow).
 */
async function routeExpired(
  props: Props,
  formSessionId: string,
): Promise<ExecuteStepResult> {
  const claimed = await formSessionService.claimExpiredRoute({
    workspaceId: props.conversation.workspaceId,
    sessionId: formSessionId,
    contactId: props.conversation.contactId,
    conversationId: props.conversation.id,
    stepId: props.step.id,
  })
  return claimed
    ? { status: "skip", result: "expired" }
    : { status: "wait", result: null }
}

function challengeNodeId(props: Props): string {
  return props.targetId ?? props.targetNodeId ?? ""
}

const scalePrompt = (prompt: string, b: { min: number; max: number }) =>
  `${prompt} (${b.min}-${b.max})`

function questionText(field: FormField): string {
  const prompt = field.chat?.prompt ?? (field.label || field.key)
  // s220c A2-4: a slider / rating is answered with a number; the range is
  // language-neutral ("(1-5)"), the reply is checked against it and its step.
  const base = FORM_SCALE_FIELD_TYPES.has(field.type)
    ? scalePrompt(prompt, formScaleBounds(field))
    : prompt
  return field.helpText ? `${base}\n${field.helpText}` : base
}

/**
 * Native buttons where the channel renders them, a list otherwise. Button
 * payloads are opaque `askform:<n>` tokens: a channel that echoes the payload
 * never sends an option value that reads as a number or a flow button.
 */
function optionPrompt(
  field: FormField,
  channel: string,
  skipLabel: string,
): { text: string; quickReplies?: MessageButtonTemplate[] } {
  const buttons: { payload: string; label: string }[] =
    field.type === "checkbox"
      ? [
          { payload: formChatPayload("yes"), label: "Yes" },
          { payload: formChatPayload("no"), label: "No" },
        ]
      : (field.options ?? []).map((o, i) => ({
          payload: formChatPayload(i),
          label: o.label,
        }))
  if (!field.required) {
    buttons.push({
      payload: formChatPayload(FORM_CHAT_SKIP_WORD),
      label: skipLabel,
    })
  }
  const text = questionText(field)
  const native =
    field.type !== "checkboxGroup" &&
    QUICK_REPLY_CHANNELS.has(channel) &&
    buttons.length > 0 &&
    buttons.length <= MAX_QUICK_REPLIES &&
    buttons.every((b) => b.label.length <= BUTTON_LABEL_MAX)
  if (native) {
    return {
      text,
      quickReplies: buttons.map((b) => ({
        id: b.payload,
        label: b.label,
        buttonType: "postback" as const,
        postback: b.payload,
      })),
    }
  }
  const skip = field.required
    ? ""
    : `\n(Reply ${skipLabel.toUpperCase()} to skip.)`
  const choices = field.options ?? []
  if (choices.length === 0) {
    return { text: `${text}${skip}` }
  }
  // Numbers only when no option is itself a number ("2" would be ambiguous).
  const numbered = formOptionsNumbered(field)
  const list = choices
    .map((o, i) => (numbered ? `${i + 1}. ${o.label}` : `- ${o.label}`))
    .join("\n")
  const unit = numbered ? "numbers" : "options"
  const hint =
    field.type === "checkboxGroup"
      ? `\n(Reply with one or more ${unit}, separated by commas.)`
      : ""
  return { text: `${text}\n${list}${hint}${skip}` }
}

async function ask(
  props: Props,
  session: FormSessionModel,
  field: FormField,
  retry: boolean,
): Promise<void> {
  const { conversation, contactInbox, step } = props
  const challengeId = session.challengeId ?? ""
  // The challenge first, so a reply that races the question still resumes
  // this step (the service's askMarker decides whether it counts).
  await conversationService.updateChallenge({
    workspaceId: conversation.workspaceId,
    conversationId: conversation.id,
    challenge: {
      type: "step",
      data: {
        flowId: props.flowVersion.flowId,
        flowVersionId: props.useLatestFlowVersion
          ? undefined
          : props.flowVersion.id,
        nodeId: session.nodeId,
        stepId: step.id,
        attempts: session.attempts + 1,
        lastAttemptAt: new Date(),
        challengeId,
        runStartedAt: props.runStartedAt?.toISOString() ?? null,
      },
    },
  })

  const workspace = await workspaceService.findById({
    id: conversation.workspaceId,
  })
  const copy =
    normalizeLanguage(workspace.language) === "vi"
      ? WEBVIEW_COPY.vi
      : WEBVIEW_COPY.en
  const retryText = retry
    ? `${field.chat?.retryMessage ?? (step.retryMessage || DEFAULT_RETRY)}\n\n`
    : ""
  const prompt = optionPrompt(field, contactInbox.channel, copy.skip)
  let quickReplies = prompt.quickReplies

  if (
    (field.type === "date" || field.type === "datetime") &&
    URL_QUICK_REPLY_CAPABLE_CHANNELS.has(contactInbox.channel)
  ) {
    const { appUrl } = await resolveTenantSettings({
      workspaceId: conversation.workspaceId,
    })
    const token = await signUserDataWebviewToken({
      workspaceId: conversation.workspaceId,
      conversationId: conversation.id,
      contactInboxId: contactInbox.id,
      contactId: conversation.contactId,
      channel: contactInbox.channel,
      flowId: props.flowVersion.flowId,
      flowVersionId: props.useLatestFlowVersion
        ? undefined
        : props.flowVersion.id,
      stepId: step.id,
      nodeId: session.nodeId,
      challengeId,
      outputFieldId: `form:${field.key}`,
      replyFormat: field.type,
      runStartedAt: props.runStartedAt?.toISOString(),
    })
    const pickerUrl = new URL("/extensions/datetime-picker", appUrl)
    pickerUrl.searchParams.set("token", token)
    quickReplies = [
      {
        id: challengeId,
        label: copy.selectDate,
        buttonType: "url",
        url: pickerUrl.toString(),
        messengerExtensions: true,
      },
    ]
  } else if (
    field.type === "location" &&
    NATIVE_LOCATION_REQUEST_CHANNELS.has(contactInbox.channel)
  ) {
    quickReplies = [
      {
        id: WHATSAPP_NATIVE_LOCATION_REQUEST,
        label: copy.sendLocation,
        buttonType: "postback",
        postback: WHATSAPP_NATIVE_LOCATION_REQUEST,
      },
    ]
  }

  const undelivered = () =>
    formSessionService.markUndelivered({
      workspaceId: conversation.workspaceId,
      sessionId: session.id,
      challengeId,
    })
  let delivered = false
  try {
    const job = await chatQueue.add(ChatJobAction.sendChatMessage, {
      type: ChatJobAction.sendChatMessage,
      data: {
        contactInbox,
        conversation,
        text: `${retryText}${prompt.text}`,
        url: field.chat?.mediaUrl,
        quickReplies,
        trackingContext: props.trackingContext,
      },
    })
    delivered = await waitForChatJobDelivered(job, {
      conversationId: conversation.id,
      stepId: step.id,
    })
  } catch (error) {
    await undelivered()
    throw error
  }
  // Only a DELIVERED question may be answered: a message stored before this
  // point was written without seeing it (probe), and a failed or timed-out
  // send (skeptic: the plain wait swallows both) ends the run at the next
  // sweep instead of letting an unrelated message answer it.
  if (delivered) {
    await formSessionService.markAsked({
      workspaceId: conversation.workspaceId,
      sessionId: session.id,
      challengeId,
    })
  } else {
    await undelivered()
  }
}

/** A run start() canceled was asking elsewhere: free that conversation. */
async function clearReplaced(
  props: Props,
  replaced: ReplacedRun | undefined,
): Promise<void> {
  if (!replaced?.challengeId) {
    return
  }
  try {
    await conversationService.consumeChallenge({
      workspaceId: props.conversation.workspaceId,
      conversationId: replaced.conversationId,
      stepId: replaced.stepId,
      challengeId: replaced.challengeId,
    })
  } catch (error) {
    logger.warn(
      { err: normalizeError(error), conversationId: replaced.conversationId },
      "askForm: failed to clear the replaced run's challenge",
    )
  }
}

/** Heading / paragraph blocks, each as its own message, in order. */
async function sendPreface(props: Props, blocks: FormField[]): Promise<void> {
  for (const block of blocks) {
    const text = [block.label, block.helpText].filter(Boolean).join("\n")
    if (text.trim() === "") {
      continue
    }
    const job = await chatQueue.add(ChatJobAction.sendChatMessage, {
      type: ChatJobAction.sendChatMessage,
      data: {
        contactInbox: props.contactInbox,
        conversation: props.conversation,
        text,
        url: block.chat?.mediaUrl,
      },
    })
    await waitForChatJobCompletion(job, {
      conversationId: props.conversation.id,
      stepId: props.step.id,
    })
  }
}

/**
 * Clear the conversation challenge only if it is still THIS run's question
 * (compare-and-clear on stepId + challengeId): a newer challenge written by
 * another step is never erased.
 */
async function clearChallenge(
  props: Props,
  session: FormSessionModel,
): Promise<void> {
  const current = (
    props.conversation.additionalAttributes as
      | ConversationAttributes
      | undefined
  )?.challenge
  const challengeId = session.challengeId ?? current?.data.challengeId
  if (!challengeId) {
    return
  }
  try {
    await conversationService.consumeChallenge({
      workspaceId: props.conversation.workspaceId,
      conversationId: props.conversation.id,
      stepId: props.step.id,
      challengeId,
    })
  } catch (error) {
    logger.warn(
      { err: normalizeError(error), conversationId: props.conversation.id },
      "askForm: failed to clear the challenge",
    )
  }
}
