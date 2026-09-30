import { contactService } from "@chatbotx.io/business"
import { contactSequenceService } from "@chatbotx.io/business/contact-sequence"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"
import {
  contactSequenceIdsPublicRequest,
  listContactSequencesPublicResponse,
  reactivateContactSequencePublicRequest,
  reactivateContactSequencePublicResponse,
  resumeContactSequencePublicResponse,
  setContactSequencesPublicRequest,
} from "@/features/contact-sequences/schema/public"
import { mcpSpec } from "@/lib/orpc/mcp-annotations"
import {
  possibleErrorsOnDeletingResource,
  possibleErrorsOnFindingResource,
  possibleErrorsOnMutatingResource,
  possibleErrorsOnReactivatingSequence,
  possibleErrorsOnResumingSequence,
} from "@/lib/orpc/orpc-error-helper"
import { workspaceTokenAuthAPIForScope } from "@/orpc"

const workspaceTokenAuthAPI = workspaceTokenAuthAPIForScope("contacts")

export const contactsSequencesPublicRouter = {
  listSequences: workspaceTokenAuthAPI
    .route({
      method: "GET",
      path: "/v1/contacts/{identifier}/sequences",
      summary: "List contact sequence subscriptions",
      description:
        "Use this to inspect a contact's sequence subscriptions after resolving the contact with `contacts.get`, including ended ones with their reason and reply state. Call `contacts.subscribeSequences` to subscribe it, or `sequences.get` to inspect a sequence.",
      tags: ["Contacts"],
      spec: mcpSpec({ visibility: "default" }),
    })
    .input(
      z.object({
        identifier: z
          .string()
          .min(1)
          .describe(
            "Contact identifier: the numeric contact id, an email address, or a phone number.",
          ),
      }),
    )
    .output(listContactSequencesPublicResponse)
    .errors(possibleErrorsOnFindingResource)
    .handler(async ({ context, input }) => {
      const workspaceId = context.workspace.id
      const contactId = await contactService.resolveIdByIdentifier({
        identifier: input.identifier,
        workspaceId,
      })
      const rows = await contactSequenceService.listByContactId({
        workspaceId,
        contactId,
        includeEnded: true,
      })
      const iso = (value: Date | null) => value?.toISOString() ?? null
      const data = rows.map((row) => ({
        ...row,
        enrolledAt: row.enrolledAt.toISOString(),
        completedAt: iso(row.completedAt),
        endedAt: iso(row.endedAt),
        repliedAt: iso(row.repliedAt),
        pausedUntil: iso(row.pausedUntil),
        updatedAt: row.updatedAt.toISOString(),
      }))
      return { data }
    }),

  subscribeSequences: workspaceTokenAuthAPI
    .route({
      method: "POST",
      path: "/v1/contacts/{identifier}/sequences",
      summary: "Subscribe contact to sequences",
      description:
        "Adds the contact identified by `identifier` to each given sequence; sequences the contact is already subscribed to are left as-is. An ended subscription resumes at the step it stopped at, unless it ended for good (bounced, unsubscribed). Use `sequences.list`/`sequences.create` first to resolve names to ids.",
      successStatus: 204,
      tags: ["Contacts"],
      spec: mcpSpec({ visibility: "default" }),
    })
    .input(
      contactSequenceIdsPublicRequest.and(
        z.object({
          identifier: z
            .string()
            .min(1)
            .describe(
              "Contact identifier: the numeric contact id, an email address, or a phone number.",
            ),
        }),
      ),
    )
    .errors(possibleErrorsOnMutatingResource)
    .handler(async ({ context, input }) => {
      const workspaceId = context.workspace.id
      const contactId = await contactService.resolveIdByIdentifier({
        identifier: input.identifier,
        workspaceId,
      })
      await contactSequenceService.subscribeContacts({
        workspaceId,
        contactIds: [contactId],
        sequenceIds: input.sequenceIds,
      })
    }),

  resumeSequence: workspaceTokenAuthAPI
    .route({
      method: "POST",
      path: "/v1/contacts/{identifier}/sequences/{sequenceId}/resume",
      summary: "Resume held sequence subscription",
      description:
        "A sequence step can require contact fields (`holdOnMissing`); a contact missing one is HELD at that step, with the reason in `contacts.listSequences` (`status` held, `lastError`). Fill the fields, then call this to put the step back on schedule. The step re-checks the fields when it runs. 409 when the subscription is not held.",
      tags: ["Contacts"],
      spec: mcpSpec({ visibility: "default" }),
    })
    .input(
      z.object({
        identifier: z
          .string()
          .min(1)
          .describe(
            "Contact identifier: the numeric contact id, an email address, or a phone number.",
          ),
        sequenceId: zodBigintAsString().describe("The held sequence's id."),
      }),
    )
    .output(resumeContactSequencePublicResponse)
    .errors(possibleErrorsOnResumingSequence)
    .handler(async ({ context, input }) => {
      const workspaceId = context.workspace.id
      const contactId = await contactService.resolveIdByIdentifier({
        identifier: input.identifier,
        workspaceId,
      })
      const { runAt } = await contactSequenceService.resumeHeldEnrollment({
        workspaceId,
        contactId,
        sequenceId: input.sequenceId,
      })
      return { runAt: runAt.toISOString() }
    }),

  reactivateSequence: workspaceTokenAuthAPI
    .route({
      method: "POST",
      path: "/v1/contacts/{identifier}/sequences/{sequenceId}/reactivate",
      summary: "Reactivate ended sequence subscription",
      description:
        "Resumes an ENDED subscription (status ended in `contacts.listSequences`) at the step it stopped at; a step it already completed is not sent again, and a contact that had finished starts over. Pass the subscription's `updatedAt` as `expectedUpdatedAt`: 409 `enrollmentChanged` when it changed since. 409 `notReactivatable` when it has not ended, or ended for good (bounced, unsubscribed).",
      tags: ["Contacts"],
      spec: mcpSpec({ visibility: "default" }),
    })
    .input(
      reactivateContactSequencePublicRequest.and(
        z.object({
          identifier: z
            .string()
            .min(1)
            .describe(
              "Contact identifier: the numeric contact id, an email address, or a phone number.",
            ),
          sequenceId: zodBigintAsString().describe("The ended sequence's id."),
        }),
      ),
    )
    .output(reactivateContactSequencePublicResponse)
    .errors(possibleErrorsOnReactivatingSequence)
    .handler(async ({ context, input }) => {
      const workspaceId = context.workspace.id
      const contactId = await contactService.resolveIdByIdentifier({
        identifier: input.identifier,
        workspaceId,
      })
      const { runAt } = await contactSequenceService.reactivateEnrollment({
        workspaceId,
        contactId,
        sequenceId: input.sequenceId,
        expectedUpdatedAt: new Date(input.expectedUpdatedAt),
      })
      return { runAt: runAt?.toISOString() ?? null }
    }),

  unsubscribeSequences: workspaceTokenAuthAPI
    .route({
      method: "DELETE",
      path: "/v1/contacts/{identifier}/sequences",
      summary: "Unsubscribe contact from sequences",
      description:
        "Removes the contact identified by `identifier` from each given sequence; sequences it isn't subscribed to are ignored. Use `contacts.listSequences` to see current subscriptions first.",
      successStatus: 204,
      tags: ["Contacts"],
    })
    .input(
      contactSequenceIdsPublicRequest.and(
        z.object({
          identifier: z
            .string()
            .min(1)
            .describe(
              "Contact identifier: the numeric contact id, an email address, or a phone number.",
            ),
        }),
      ),
    )
    .errors(possibleErrorsOnDeletingResource)
    .handler(async ({ context, input }) => {
      const workspaceId = context.workspace.id
      const contactId = await contactService.resolveIdByIdentifier({
        identifier: input.identifier,
        workspaceId,
      })
      await contactSequenceService.removeContactSequencesForContacts({
        workspaceId,
        contactIds: [contactId],
        sequenceIds: input.sequenceIds,
        reason: "subscription_removed",
      })
    }),

  setSequences: workspaceTokenAuthAPI
    .route({
      method: "PUT",
      path: "/v1/contacts/{identifier}/sequences",
      summary: "Replace contact sequence subscriptions",
      description:
        "Sets the contact's active sequence subscriptions to exactly this list — sequences not in `sequenceIds` are unsubscribed, missing ones are subscribed. Pass an empty array to unsubscribe from everything.",
      successStatus: 204,
      tags: ["Contacts"],
    })
    .input(
      setContactSequencesPublicRequest.and(
        z.object({
          identifier: z
            .string()
            .min(1)
            .describe(
              "Contact identifier: the numeric contact id, an email address, or a phone number.",
            ),
        }),
      ),
    )
    .errors(possibleErrorsOnMutatingResource)
    .handler(async ({ context, input }) => {
      const workspaceId = context.workspace.id
      const contactId = await contactService.resolveIdByIdentifier({
        identifier: input.identifier,
        workspaceId,
      })
      await contactSequenceService.updateContactSequences({
        workspaceId,
        contactId,
        sequenceIds: input.sequenceIds,
      })
    }),
}
