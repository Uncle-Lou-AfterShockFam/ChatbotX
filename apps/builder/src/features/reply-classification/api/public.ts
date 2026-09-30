import { contactService } from "@chatbotx.io/business"
import { replyClassificationService } from "@chatbotx.io/business/reply-classification"
import { z } from "zod"
import { mcpSpec } from "@/lib/orpc/mcp-annotations"
import {
  possibleErrorsOnFindingResource,
  possibleErrorsOnMutatingResource,
} from "@/lib/orpc/orpc-error-helper"
import { workspaceTokenAuthAPIForScope } from "@/orpc"
import {
  classifyReplyPublicRequest,
  classifyReplyPublicResponse,
  listReplyClassificationsPublicResponse,
  toClassificationResource,
} from "../schema/public"

const workspaceTokenAuthAPI = workspaceTokenAuthAPIForScope("contacts")

const identifier = z
  .string()
  .min(1)
  .describe(
    "Contact identifier: the numeric contact id, an email address, or a phone number.",
  )

/** s228b outreach step 2: classify a contact's answer to outreach. */
export const contactsReplyClassificationPublicRouter = {
  classifyReply: workspaceTokenAuthAPI
    .route({
      method: "POST",
      path: "/v1/contacts/{identifier}/reply-classification",
      summary: "Classify contact reply",
      description:
        "Records how the contact answered outreach. When the contact's outreach sequence has an Outreach pipeline (`sequences.createOutreachPipeline`), interested and maybeLater open the contact's deal at that stage or move the open one there, and notInterested moves an open deal to the lost stage. Emits the contactReplyClassified trigger. Use `contacts.listReplyClassifications` to read them back.",
      tags: ["Contacts"],
      spec: mcpSpec({ visibility: "default" }),
    })
    .input(classifyReplyPublicRequest.and(z.object({ identifier })))
    .output(classifyReplyPublicResponse)
    .errors(possibleErrorsOnMutatingResource)
    .handler(async ({ context, input }) => {
      const workspaceId = context.workspace.id
      const contactId = await contactService.resolveIdByIdentifier({
        identifier: input.identifier,
        workspaceId,
      })
      const { classification } = await replyClassificationService.classifyReply(
        {
          workspaceId,
          contactId,
          class: input.class,
          source: "manual",
          reason: input.reason ?? null,
          sequenceId: input.sequenceId ?? null,
        },
      )
      if (!classification) {
        throw new Error("classifyReply: a manual class is always recorded")
      }
      return { data: toClassificationResource(classification) }
    }),

  listReplyClassifications: workspaceTokenAuthAPI
    .route({
      method: "GET",
      path: "/v1/contacts/{identifier}/reply-classifications",
      summary: "List contact reply classifications",
      description:
        "The contact's reply classifications, newest first (the first is the current one): an operator's interested / maybeLater / notInterested and the email line's ooo / auto / bounce.",
      tags: ["Contacts"],
    })
    .input(z.object({ identifier }))
    .output(listReplyClassificationsPublicResponse)
    .errors(possibleErrorsOnFindingResource)
    .handler(async ({ context, input }) => {
      const workspaceId = context.workspace.id
      const contactId = await contactService.resolveIdByIdentifier({
        identifier: input.identifier,
        workspaceId,
      })
      const rows = await replyClassificationService.listByContact({
        workspaceId,
        contactId,
      })
      return { data: rows.map(toClassificationResource) }
    }),
}
