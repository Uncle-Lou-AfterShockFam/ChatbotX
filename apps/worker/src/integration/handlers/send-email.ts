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
import type { ExecuteStepProps } from "./flow"

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

  const smtpIntegration = await integrationSmtpService.find({
    where: {
      workspaceId: conversation.workspaceId,
      id: step.integrationSmtpId,
    },
  })
  if (!smtpIntegration) {
    logger.warn(
      `handleSendEmail: smtp integration ${step.integrationSmtpId} not found`,
    )
    return
  }

  const auth = smtpAuthSchema.parse({
    authType: "custom",
    ...(smtpIntegration.auth as Record<string, unknown>),
  })

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

  const [to, subject, preheader] = await Promise.all([
    contactVariableService.replaceAll({ text: step.to, variables }),
    contactVariableService.replaceAll({ text: step.subject, variables }),
    contactVariableService.replaceAll({ text: step.preheader, variables }),
  ])

  const unsubscribeUrl = await buildUnsubscribeUrl(
    appUrl,
    conversation.contactId,
    conversation.workspaceId,
  )

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
      email: to,
      broadcastId: broadcast?.broadcastId ?? null,
    })
    token = result.token
  }

  const elements = await resolveElements({
    appUrl,
    rawElements: step.elements,
    variables,
    inbox,
    flowId: flowVersion.flowId,
    unsubscribeUrl,
    token,
    workspaceId: conversation.workspaceId,
  })

  const props: DynamicEmailProps = {
    brandName: workspace.name ?? smtpIntegration.name,
    subject,
    preheader,
    elements,
  }

  const botContext = await buildContext({
    workspaceId: workspace.id,
    integrationType: "smtp",
    integration: { ...smtpIntegration, auth },
  })

  // RFC 8058 one-click: the mail client POSTs to this URL; the /unsubscribe
  // page itself only unsubscribes after a confirm (link scanners GET it).
  const oneClickUrl = new URL(unsubscribeUrl)
  oneClickUrl.pathname = "/unsubscribe/one-click"

  try {
    await integrationSmtp.runAction("sendMail", {
      ctx: botContext,
      from: step.from || smtpIntegration.fromAddress,
      to,
      subject,
      html: await renderDynamicEmailHtml(props),
      text: renderDynamicEmailText(elements),
      headers: {
        "List-Unsubscribe": `<${oneClickUrl.toString()}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    })
  } catch (err) {
    logger.error(
      {
        err,
        integrationSmtpId: smtpIntegration.id,
        workspaceId: conversation.workspaceId,
      },
      "handleSendEmail: SMTP send failed",
    )
    if (token) {
      await emailTopicAnalyticsService.markFailed(token)
    }
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
