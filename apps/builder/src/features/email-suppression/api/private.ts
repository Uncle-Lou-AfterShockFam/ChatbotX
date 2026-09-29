import { emailSuppressionService } from "@chatbotx.io/business/email-suppression"
import { zodBigintAsString } from "@chatbotx.io/utils"
import z from "zod"
import { withWorkspaceIdSchema } from "@/features/workspaces/schema/resource"
import { contactsAccessAuthorizedMiddleware } from "@/middlewares/auth"
import { authorizedAPI } from "@/orpc"
import {
  emailSuppressionData,
  emailSuppressionListQuery,
  emailSuppressionResource,
} from "../schema/resource"

/**
 * Email suppression (outreach B-1, s224b): addresses and @domains the email
 * step never sends to. Gated like the contacts section it protects.
 */
const tags = ["Email suppression"]

const privateListEmailSuppressionsAPI = authorizedAPI
  .route({
    method: "GET",
    path: "/workspaces/{workspaceId}/email-suppressions",
    summary: "List suppressed email addresses and domains",
    tags,
  })
  .input(withWorkspaceIdSchema.and(emailSuppressionListQuery))
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(
    z.object({
      data: z.array(emailSuppressionResource),
      nextCursor: z.string().nullable(),
    }),
  )
  .handler(async ({ input }) => {
    const page = await emailSuppressionService.list({
      workspaceId: input.workspaceId,
      cursor: input.cursor ?? null,
      limit: input.limit,
    })
    return { data: page.items, nextCursor: page.nextCursor }
  })

const privateAddEmailSuppressionAPI = authorizedAPI
  .route({
    method: "POST",
    path: "/workspaces/{workspaceId}/email-suppressions",
    summary: "Suppress an email address or @domain",
    tags,
  })
  .input(withWorkspaceIdSchema.and(emailSuppressionData))
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(emailSuppressionResource)
  .handler(
    async ({ input, context }) =>
      await emailSuppressionService.add({
        workspaceId: input.workspaceId,
        value: input.value,
        userId: context.user.id,
      }),
  )

const privateRemoveEmailSuppressionAPI = authorizedAPI
  .route({
    method: "DELETE",
    path: "/workspaces/{workspaceId}/email-suppressions/{id}",
    summary: "Remove a suppression entry",
    tags,
  })
  .input(withWorkspaceIdSchema.and(z.object({ id: zodBigintAsString() })))
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(z.object({ ok: z.literal(true) }))
  .handler(async ({ input }) => {
    await emailSuppressionService.remove({
      workspaceId: input.workspaceId,
      id: input.id,
    })
    return { ok: true as const }
  })

export const privateEmailSuppressionAPI = {
  privateListEmailSuppressionsAPI,
  privateAddEmailSuppressionAPI,
  privateRemoveEmailSuppressionAPI,
}
