import { randomUUID } from "node:crypto"
import { emailTopicAnalyticsService } from "@chatbotx.io/analytics"
import {
  buildContext,
  buildUnsubscribeUrl,
  contactService,
  inboxService,
  integrationSmtpService,
  resolveTenantSettings,
  signEmailClickUrl,
  workspaceService,
} from "@chatbotx.io/business"
import type { InboxWithIntegrations } from "@chatbotx.io/database/types"
import type {
  EmailStepSchema,
  PageElementSchema,
} from "@chatbotx.io/flow-config"
import {
  BROADCAST_PAYLOAD_TYPE,
  UNSUBSCRIBE_PLACEHOLDER,
} from "@chatbotx.io/flow-config"
import {
  integration as integrationSmtp,
  smtpAuthSchema,
} from "@chatbotx.io/integration-smtp"
import type {
  DynamicEmailProps,
  MailElementSchema,
} from "@chatbotx.io/mail/dynamic"
import { renderDynamicEmailHtml } from "@chatbotx.io/mail/dynamic"
import {
  extractHttpHrefs,
  renderDynamicEmailText,
  rewriteHtmlLinks,
} from "@chatbotx.io/mail/extras"
import { contactVariableService } from "@chatbotx.io/variables"
import { resolveButtonUrl } from "../../lib/convert-button"
import { logger } from "../../lib/logger"
import { resolveIntegrationContextFromContactInbox } from "../../services/integrations"
import type { ExecuteStepProps } from "./flow"
import { lineEmailRef } from "./line-email-status"
import {
  EmailContentError,
  type MailAttachment,
  type PreparedDocument,
  prepareStepDocument,
  renderStepDocument,
} from "./send-email-document"
import { buildLineEmail, resolveEmailLine } from "./send-email-line"

async function resolveElements({
  appUrl,
  rawElements,
  variables,
  inbox,
  flowId,
  unsubscribeUrl,
  token,
  workspaceId,
}: {
  appUrl: string
  rawElements: PageElementSchema[]
  variables: Awaited<ReturnType<typeof contactVariableService.getAll>>
  inbox: InboxWithIntegrations | undefined
  flowId: string | undefined
  unsubscribeUrl: string
  token?: string
  workspaceId: string
}): Promise<MailElementSchema[]> {
  const resolved: MailElementSchema[] = []
  // Links the operator typed into text are tracked like buttons (s220b). Only
  // hrefs present in the template BEFORE merge fields are filled in: a link
  // arriving inside a contact's field value is never signed by the hub.
  const trackUrl = async (url: string) =>
    `${appUrl}/email-topic/click?r=${token}&u=${await signEmailClickUrl(url, workspaceId)}`

  for (const el of rawElements) {
    switch (el.type) {
      case "heading":
      case "text":
      case "code": {
        const resolvedText = await contactVariableService.replaceAll({
          text: el.text,
          variables,
        })
        const text = resolvedText.replaceAll(
          UNSUBSCRIBE_PLACEHOLDER,
          unsubscribeUrl,
        )
        resolved.push({
          type: el.type,
          text:
            token && el.type !== "code"
              ? await rewriteHtmlLinks(
                  text,
                  trackUrl,
                  new Set(extractHttpHrefs(el.text)),
                )
              : text,
        })
        break
      }
      case "image":
        resolved.push({
          type: "image",
          url: el.url,
        })
        break
      case "line":
      case "spacing":
        resolved.push({ type: el.type })
        break
      case "button": {
        let url = el.buttonType
          ? resolveButtonUrl({
              appUrl,
              button: el,
              inbox,
              flowId,
            })
          : undefined

        if (url && token) {
          // Seal the destination into an authenticated token so the click
          // route cannot be abused as an open redirect (the raw URL is never
          // trusted from the query string). base64url is URL-safe.
          url = await trackUrl(url)
        }

        resolved.push({ type: "button", url, label: el.label })
        break
      }
      default:
        break
    }
  }

  if (token) {
    resolved.push({
      type: "image",
      url: `${appUrl}/email-topic/open?r=${token}`,
    })
  }

  return resolved
}

/** The pre-B2 path, unchanged: elements -> MJML dynamic template. */
async function renderLegacyElements(props: {
  appUrl: string
  step: EmailStepSchema
  variables: Awaited<ReturnType<typeof contactVariableService.getAll>>
  inbox: InboxWithIntegrations | undefined
  flowId: string | undefined
  unsubscribeUrl: string
  token: string | undefined
  workspaceId: string
  brandName: string
  subject: string
  preheader: string
}): Promise<{ html: string; text: string }> {
  const elements = await resolveElements({
    appUrl: props.appUrl,
    rawElements: props.step.elements,
    variables: props.variables,
    inbox: props.inbox,
    flowId: props.flowId,
    unsubscribeUrl: props.unsubscribeUrl,
    token: props.token,
    workspaceId: props.workspaceId,
  })
  const emailProps: DynamicEmailProps = {
    brandName: props.brandName,
    subject: props.subject,
    preheader: props.preheader,
    elements,
  }
  return {
    html: await renderDynamicEmailHtml(emailProps),
    text: renderDynamicEmailText(elements),
  }
}

type RenderedMail = {
  html: string
  text: string
  attachments?: MailAttachment[]
}

/** Hub SMTP. False when the send failed (logged; the caller marks it). */
async function sendViaSmtp(props: {
  workspaceId: string
  smtpIntegration: NonNullable<
    Awaited<ReturnType<typeof integrationSmtpService.find>>
  >
  auth: ReturnType<typeof smtpAuthSchema.parse>
  from: string
  to: string
  subject: string
  body: RenderedMail
  headers: Record<string, string>
}): Promise<boolean> {
  const { smtpIntegration, body } = props
  const botContext = await buildContext({
    workspaceId: props.workspaceId,
    integrationType: "smtp",
    integration: { ...smtpIntegration, auth: props.auth },
  })
  try {
    await integrationSmtp.runAction("sendMail", {
      ctx: botContext,
      from: props.from || smtpIntegration.fromAddress,
      to: props.to,
      subject: props.subject,
      html: body.html,
      text: body.text,
      attachments: body.attachments?.map(
        ({ filename, content, contentType }) => ({
          filename,
          content,
          contentType,
        }),
      ),
      headers: props.headers,
    })
    return true
  } catch (err) {
    logger.error(
      {
        err,
        integrationSmtpId: smtpIntegration.id,
        workspaceId: props.workspaceId,
      },
      "handleSendEmail: SMTP send failed",
    )
    return false
  }
}

/**
 * B2 phase 4 (s222b): queue the rendered mail for the bulktext email line
 * (pull mode; the line's final status settles it later). A mail past the
 * line's caps is unusable content (logged, false); a push-mode or unreachable
 * line fails the send the same way SMTP does.
 */
async function sendViaLine(props: {
  workspaceId: string
  appUrl: string
  lineContactInbox: Awaited<ReturnType<typeof resolveEmailLine>>
  subject: string
  body: RenderedMail
  headers: Record<string, string>
  ref: string
}): Promise<boolean> {
  const { lineContactInbox } = props
  const log = {
    workspaceId: props.workspaceId,
    lineInboxId: lineContactInbox.inboxId,
  }
  let email: Awaited<ReturnType<typeof buildLineEmail>>
  try {
    email = await buildLineEmail({
      appUrl: props.appUrl,
      subject: props.subject,
      html: props.body.html,
      text: props.body.text,
      headers: props.headers,
      attachments: props.body.attachments ?? [],
    })
  } catch (err) {
    if (!(err instanceof EmailContentError)) {
      throw err
    }
    logger.error(
      { err, ...log },
      "handleSendEmail: too large for the email line",
    )
    return false
  }
  try {
    const { integration, ctx } =
      await resolveIntegrationContextFromContactInbox({
        workspaceId: props.workspaceId,
        contactInbox: lineContactInbox,
      })
    await integration.runAction("sendEmail", {
      ctx,
      contact: { id: lineContactInbox.id, sourceId: lineContactInbox.sourceId },
      email,
      ref: props.ref,
    })
    return true
  } catch (err) {
    logger.error({ err, ...log }, "handleSendEmail: the email line send failed")
    return false
  }
}

const SINGLE_MAILBOX_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/

/**
 * The resolved recipient is exactly the contact's stored email (one address,
 * case-insensitive). A list, a different or an empty address is not.
 */
export const isContactsOwnAddress = (
  to: string,
  contactEmail: string | null | undefined,
): boolean => {
  const own = contactEmail?.trim().toLowerCase()
  // ONE mailbox: a stored "email" that is really a list (the contact field
  // takes any string) must not pass as its own recipient
  return (
    Boolean(own) &&
    SINGLE_MAILBOX_RE.test(own ?? "") &&
    to.trim().toLowerCase() === own
  )
}

export async function sendEmail({
  conversation,
  flowVersion,
  step,
  contactInbox,
  metadata,
}: ExecuteStepProps<EmailStepSchema>) {
  const contact = await contactService.findBy({
    where: { id: conversation.contactId },
  })
  if (!contact?.emailOptIn) {
    logger.info(
      { contactId: conversation.contactId },
      "handleSendEmail: contact has opted out of email, skipping",
    )
    return
  }

  // B2 phase 4 (s222b): a step with an email LINE sends through that
  // API-channel inbox (bulktext) instead of hub SMTP; everything up to the
  // rendered mail is shared.
  const lineInboxId = step.lineInboxId || undefined
  const smtpIntegration = lineInboxId
    ? undefined
    : await integrationSmtpService.find({
        where: {
          workspaceId: conversation.workspaceId,
          id: step.integrationSmtpId,
        },
      })
  if (!(lineInboxId || smtpIntegration)) {
    logger.warn(
      `handleSendEmail: smtp integration ${step.integrationSmtpId} not found`,
    )
    return
  }
  // Validated BEFORE the tracking row: bad stored auth must not leave an
  // unsettled recipient behind on every retry (Codex probe s222b).
  const smtpAuth = smtpIntegration
    ? smtpAuthSchema.parse({
        authType: "custom",
        ...(smtpIntegration.auth as Record<string, unknown>),
      })
    : undefined

  const workspace = await workspaceService.findById({
    id: conversation.workspaceId,
  })

  const inbox = await inboxService.find({
    where: {
      id: contactInbox.inboxId,
      workspaceId: conversation.workspaceId,
    },
  })

  const variables = await contactVariableService.getAll({
    contactId: conversation.contactId,
    contactInbox,
    conversation,
    workspace,
  })
  const { appUrl } = await resolveTenantSettings({
    workspaceId: conversation.workspaceId,
  })

  const to = await contactVariableService.replaceAll({
    text: step.to,
    variables,
  })

  const unsubscribeUrl = await buildUnsubscribeUrl(
    appUrl,
    conversation.contactId,
    conversation.workspaceId,
  )

  // B2 (s220b/s221b): a template or inline document is READ before the
  // tracking row is written (a transient read error retries with nothing
  // written); unusable content is still counted, then marked failed. The
  // email line (s222b) is resolved here too: its address IS the recipient.
  const isDocument = Boolean(step.templateId || step.document)
  let prepared: PreparedDocument | undefined
  let contentError: EmailContentError | undefined
  let lineContactInbox: Awaited<ReturnType<typeof resolveEmailLine>> | undefined
  if (lineInboxId) {
    try {
      lineContactInbox = await resolveEmailLine({
        workspaceId: conversation.workspaceId,
        contactId: conversation.contactId,
        lineInboxId,
      })
    } catch (err) {
      if (!(err instanceof EmailContentError)) {
        throw err
      }
      contentError = err
    }
  }
  const recipient = lineContactInbox?.sourceId ?? to
  // Personal (bearer) links only in mail DELIVERED to the contact's own,
  // single address (the email line's identity when it sends): an owner may
  // address this step to someone else, and that reader must not get the
  // contact's link (Codex reviews s220c). Decided before any content is
  // resolved; every render below reads this context.
  variables.personalLinks = isContactsOwnAddress(
    recipient,
    variables.contact?.email,
  )
  const [subject, preheader] = await Promise.all([
    contactVariableService.replaceAll({ text: step.subject, variables }),
    contactVariableService.replaceAll({ text: step.preheader, variables }),
  ])
  if (isDocument && !contentError) {
    try {
      prepared = await prepareStepDocument({
        step,
        workspaceId: conversation.workspaceId,
        variables,
        broadcastId:
          metadata?.type === BROADCAST_PAYLOAD_TYPE
            ? String(metadata.broadcastId)
            : undefined,
      })
    } catch (err) {
      if (!(err instanceof EmailContentError)) {
        throw err
      }
      contentError = err
    }
  }

  // Create per-recipient tracking row before building URLs so the token is available.
  let token: string | undefined
  if (step.topicId) {
    // A broadcast's send (s220b): delivery, opens and clicks also stamp the
    // recipient's ContactOnBroadcast row, keyed by the broadcast's OWN
    // contactInboxId (the one its row was written with).
    const broadcast =
      metadata?.type === BROADCAST_PAYLOAD_TYPE ? metadata : undefined
    const result = await emailTopicAnalyticsService.createRecipient({
      topicId: step.topicId,
      workspaceId: conversation.workspaceId,
      contactId: conversation.contactId,
      conversationId: conversation.id,
      contactInboxId: broadcast?.contactInboxId ?? contactInbox.id,
      email: recipient,
      broadcastId: broadcast?.broadcastId ?? null,
    })
    token = result.token
  }

  if (contentError) {
    logger.error(
      {
        err: contentError,
        workspaceId: conversation.workspaceId,
        templateId: step.templateId,
        lineInboxId,
      },
      "handleSendEmail: email content could not be prepared",
    )
    if (token) {
      await emailTopicAnalyticsService.markFailed(token)
    }
    return
  }

  // Legacy `elements` keep the original path (no try: its errors propagate
  // to the queue's retry, as they always did).
  let body: { html: string; text: string; attachments?: MailAttachment[] }
  if (isDocument) {
    try {
      body = await renderStepDocument({
        prepared: prepared as PreparedDocument,
        workspaceId: conversation.workspaceId,
        appUrl,
        inbox,
        flowId: flowVersion.flowId,
        unsubscribeUrl,
        token,
        contact: {
          id: conversation.contactId,
          contactInboxId: lineContactInbox?.id ?? contactInbox.id,
        },
      })
    } catch (err) {
      // Only unusable CONTENT (template gone, invalid document, a bad
      // attachment) fails the send closed; a transient error retries.
      if (!(err instanceof EmailContentError)) {
        throw err
      }
      logger.error(
        {
          err,
          workspaceId: conversation.workspaceId,
          templateId: step.templateId,
        },
        "handleSendEmail: email content could not be rendered",
      )
      if (token) {
        await emailTopicAnalyticsService.markFailed(token)
      }
      return
    }
  } else {
    body = await renderLegacyElements({
      appUrl,
      step,
      variables,
      inbox,
      flowId: flowVersion.flowId,
      unsubscribeUrl,
      token,
      workspaceId: conversation.workspaceId,
      brandName: workspace.name ?? smtpIntegration?.name ?? "",
      subject,
      preheader,
    })
  }

  // RFC 8058 one-click: the mail client POSTs to this URL; the /unsubscribe
  // page itself only unsubscribes after a confirm (link scanners GET it).
  const oneClickUrl = new URL(unsubscribeUrl)
  oneClickUrl.pathname = "/unsubscribe/one-click"
  const headers = {
    "List-Unsubscribe": `<${oneClickUrl.toString()}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  }

  const sent = lineContactInbox
    ? await sendViaLine({
        workspaceId: conversation.workspaceId,
        appUrl,
        lineContactInbox,
        subject,
        body,
        headers,
        ref: lineEmailRef(token, randomUUID()),
      })
    : await sendViaSmtp({
        workspaceId: workspace.id,
        smtpIntegration: smtpIntegration as NonNullable<typeof smtpIntegration>,
        auth: smtpAuth as NonNullable<typeof smtpAuth>,
        from: step.from,
        to,
        subject,
        body,
        headers,
      })
  if (!sent) {
    if (token) {
      await emailTopicAnalyticsService.markFailed(token)
    }
    return
  }
  // The line only QUEUED it: its own delivered / failed status settles the
  // row (line-email-status.ts), since failed never overrides delivered.
  if (lineContactInbox) {
    return
  }

  // Outside the send's try: a stats write failing after a sent mail must
  // never mark that mail failed (it would count it twice in the broadcast).
  if (token) {
    try {
      await emailTopicAnalyticsService.markDelivered(token)
    } catch (err) {
      logger.warn({ err, token }, "handleSendEmail: markDelivered failed")
    }
  }
}
