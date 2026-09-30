import { emailSenderService } from "@chatbotx.io/business/email-sender"
import { zodBigintAsString } from "@chatbotx.io/utils"
import z from "zod"
import { withWorkspaceIdSchema } from "@/features/workspaces/schema/resource"
import { contactsAccessAuthorizedMiddleware } from "@/middlewares/auth"
import { authorizedAPI } from "@/orpc"
import {
  createEmailSenderData,
  emailSenderLineResource,
  emailSenderResource,
  setEmailSenderStatusData,
  updateEmailSenderData,
} from "../schema/resource"

/**
 * Mailbox senders (ManyReach step 3, s229b): the mailboxes an email line
 * sends from. Gated like the email suppression list. No route ever returns
 * the secret or a password (the output schemas carry neither).
 */
const tags = ["Email senders"]
const base = "/workspaces/{workspaceId}/email-senders"

const privateListEmailSendersAPI = authorizedAPI
  .route({
    method: "GET",
    path: base,
    summary: "List the email lines and their mailbox senders",
    tags,
  })
  .input(withWorkspaceIdSchema)
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(
    z.object({
      lines: z.array(emailSenderLineResource),
      senders: z.array(emailSenderResource),
    }),
  )
  .handler(async ({ input }) => {
    const [lines, senders] = await Promise.all([
      emailSenderService.listLines({ workspaceId: input.workspaceId }),
      emailSenderService.list({ workspaceId: input.workspaceId }),
    ])
    return { lines, senders }
  })

const privateCreateEmailSenderAPI = authorizedAPI
  .route({
    method: "POST",
    path: base,
    summary: "Add an SMTP/IMAP mailbox sender to an email line",
    tags,
  })
  .input(withWorkspaceIdSchema.and(createEmailSenderData))
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(emailSenderResource)
  .handler(
    async ({ input, context }) =>
      await emailSenderService.create(input, context.user.id),
  )

const privateUpdateEmailSenderAPI = authorizedAPI
  .route({
    method: "PATCH",
    path: `${base}/{id}`,
    summary: "Edit a mailbox sender (a blank password keeps the stored one)",
    tags,
  })
  .input(withWorkspaceIdSchema.and(updateEmailSenderData))
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(emailSenderResource)
  .handler(async ({ input }) => await emailSenderService.update(input))

const privateSetEmailSenderStatusAPI = authorizedAPI
  .route({
    method: "POST",
    path: `${base}/{id}/status`,
    summary: "Set a mailbox sender active, paused or draining",
    tags,
  })
  .input(withWorkspaceIdSchema.and(setEmailSenderStatusData))
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(emailSenderResource)
  .handler(async ({ input }) => await emailSenderService.setStatus(input))

const privateArchiveEmailSenderAPI = authorizedAPI
  .route({
    method: "DELETE",
    path: `${base}/{id}`,
    summary: "Archive a mailbox sender (its threads fail closed)",
    tags,
  })
  .input(withWorkspaceIdSchema.and(z.object({ id: zodBigintAsString() })))
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(z.object({ ok: z.literal(true) }))
  .handler(async ({ input }) => {
    await emailSenderService.archive({
      workspaceId: input.workspaceId,
      id: input.id,
    })
    return { ok: true as const }
  })

export const privateEmailSenderAPI = {
  privateListEmailSendersAPI,
  privateCreateEmailSenderAPI,
  privateUpdateEmailSenderAPI,
  privateSetEmailSenderStatusAPI,
  privateArchiveEmailSenderAPI,
}
