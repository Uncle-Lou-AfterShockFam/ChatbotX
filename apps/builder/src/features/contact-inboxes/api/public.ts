import {
  attachContactToInbox,
  contactInboxService,
  contactService,
} from "@chatbotx.io/business"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"
import {
  attachContactInboxPublicResponse,
  listContactInboxesPublicResponse,
} from "@/features/contact-inboxes/schema/public"
import {
  possibleErrorsOnAttachingContactInbox,
  possibleErrorsOnFindingResource,
} from "@/lib/orpc/orpc-error-helper"
import { workspaceTokenAuthAPIForScope } from "@/orpc"

const workspaceTokenAuthAPI = workspaceTokenAuthAPIForScope("contacts")

export const contactsInboxesPublicRouter = {
  listInboxes: workspaceTokenAuthAPI
    .route({
      method: "GET",
      path: "/v1/contacts/{identifier}/inboxes",
      summary: "List contact channel identities",
      description:
        "Returns each channel-specific connection (contact inbox) this contact has, e.g. their WhatsApp phone number or Messenger PSID per inbox. Use `contacts.get` to resolve the contact first.",
      tags: ["Contacts"],
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
    .output(listContactInboxesPublicResponse)
    .errors(possibleErrorsOnFindingResource)
    .handler(async ({ context, input }) => {
      const workspaceId = context.workspace.id
      const contactId = await contactService.resolveIdByIdentifier({
        identifier: input.identifier,
        workspaceId,
      })
      const data = await contactInboxService.listByContactIdUncached({
        workspaceId,
        contactId,
      })
      return { data }
    }),

  attachInbox: workspaceTokenAuthAPI
    .route({
      method: "POST",
      path: "/v1/contacts/{identifier}/inboxes",
      summary: "Attach contact to api inbox",
      description:
        "Registers an existing contact on an `api`-channel inbox by creating its channel identity (contact inbox) there, so `contacts.sendFlow` / `contacts.sendMessage` with that `inboxId` work for a contact that came from another channel (e.g. an Instagram DM). `sourceId` defaults to the contact's phone number in E.164, which is what an external line worker posts inbound messages under. Idempotent for the same contact; 409 when the identity belongs to another contact. Other channels are rejected: their identities are minted by the provider.",
      tags: ["Contacts"],
    })
    .input(
      z.strictObject({
        identifier: z
          .string()
          .min(1)
          .describe(
            "Contact identifier: the numeric contact id, an email address, or a phone number.",
          ),
        inboxId: zodBigintAsString().describe(
          "Inbox id (numeric string) of an `api`-channel inbox. Get it from `inboxes.list`.",
        ),
        sourceId: z
          .string()
          .trim()
          .min(1)
          .max(255)
          .optional()
          .describe(
            "Channel identity to register on the inbox. Defaults to the contact's phone number in E.164.",
          ),
        onConflict: z
          .enum(["error", "resolve"])
          .optional()
          .describe(
            "When the identity already belongs to another contact: `error` (default) answers 409; `resolve` answers 200 with that owner's identity (`data.contactId` is the owner, `ownedByAnotherContact: true`) and writes nothing, so a flow can message the existing contact instead of merging.",
          ),
      }),
    )
    .output(attachContactInboxPublicResponse)
    .errors(possibleErrorsOnAttachingContactInbox)
    .handler(async ({ context, input }) => {
      const workspaceId = context.workspace.id
      const contactId = await contactService.resolveIdByIdentifier({
        identifier: input.identifier,
        workspaceId,
      })
      const { contactInbox, inbox, created, ownedByAnotherContact } =
        await attachContactToInbox({
          workspaceId,
          contactId,
          inboxId: input.inboxId,
          sourceId: input.sourceId,
          onConflict: input.onConflict,
        })
      return {
        data: { ...contactInbox, inbox: { name: inbox.name } },
        created,
        ownedByAnotherContact,
      }
    }),
}
