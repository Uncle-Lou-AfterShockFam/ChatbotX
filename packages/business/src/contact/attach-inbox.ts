import { db, findOrFail } from "@chatbotx.io/database/client"
import { channelTypes, contactSources } from "@chatbotx.io/database/partials"
import { contactInboxModel, inboxModel } from "@chatbotx.io/database/schema"
import type {
  ContactInboxModel,
  ConversationModel,
  InboxModel,
} from "@chatbotx.io/database/types"
import { parsePhoneNumberFromString } from "libphonenumber-js"
import { dispatchAuditRecord } from "../audit/dispatcher"
import { contactInboxService } from "../contact-inbox/service"
import { conversationService } from "../conversation/service"
import { ChatbotXException, validationException } from "../errors"
import { messageCleanupService } from "../message-cleanup/service"
import { workspaceService } from "../workspace/service"
import { resolveDefaultRegion } from "./create-with-inbox"
import { contactService } from "./service"

export type AttachContactToInboxInput = {
  workspaceId: string
  contactId: string
  inboxId: string
  /** Channel identity to register; defaults to the contact's E.164 phone. */
  sourceId?: string
  /**
   * What to do when the identity already belongs to ANOTHER contact on the
   * inbox: `error` (default) throws the 409; `resolve` returns that owner's
   * row with `ownedByAnotherContact: true` and writes nothing, so a caller
   * (a flow) can address the existing contact instead of merging.
   */
  onConflict?: "error" | "resolve"
}

export type AttachContactToInboxResult = {
  contactInbox: ContactInboxModel
  conversation: ConversationModel
  inbox: InboxModel
  /** false when the identity was already attached to this contact. */
  created: boolean
  /**
   * true only with `onConflict: "resolve"` when the identity belongs to
   * another contact: `contactInbox.contactId` is that owner, `conversation` is
   * the owner's DM conversation, nothing was written.
   */
  ownedByAnotherContact: boolean
}

export const CONTACT_INBOX_OWNED_BY_ANOTHER_CONTACT =
  "contactInboxOwnedByAnotherContact"

// A caller-supplied sourceId that LOOKS like a phone number (digits with an
// optional "+", spaces, dashes, dots or parentheses) is normalised to E.164
// exactly like the default path, so it cannot silently diverge from - or
// squat on - the canonical string the line worker posts inbound under.
// Anything else (an external id like "ext-42") is the caller's own and is
// stored verbatim.
const PHONE_SHAPED_PATTERN = /^\+?[\d\s().-]{7,}$/

const ownedByAnotherContact = () =>
  new ChatbotXException(
    "This channel identity already belongs to another contact on this inbox",
    CONTACT_INBOX_OWNED_BY_ANOTHER_CONTACT,
    409,
  )

/**
 * Attach an EXISTING contact to an `api`-channel inbox by creating the
 * `ContactInbox` row a flow or message on that inbox needs
 * (`conversationService.resolveContactInboxForSend` only finds rows that
 * exist; nothing else creates one for a contact born on another channel).
 *
 * `api` only: on every other channel the `sourceId` is minted by the
 * provider (PSID, IGSID, wa_id, ...) and a caller-supplied value would be a
 * row the channel can never deliver to. On the `api` channel the contract
 * already says `contact.sourceId` is the caller's own id, so the caller owns
 * it; the line worker posts inbound messages with `sourceId` = E.164 phone,
 * which is why that is the default here.
 *
 * Idempotent: the same identity on the same contact returns the existing row
 * with `created: false`. An identity owned by ANOTHER contact is a 409 and is
 * never merged. Emits no contact event: `newContact` triggers, webhooks and
 * the contact counter must not fire for an attach.
 */
export const attachContactToInbox = async (
  input: AttachContactToInboxInput,
): Promise<AttachContactToInboxResult> => {
  if (!input || typeof input !== "object") {
    throw validationException("input", "Attach input is required")
  }
  const { workspaceId, contactId, inboxId, onConflict = "error" } = input
  if (onConflict !== "error" && onConflict !== "resolve") {
    throw validationException(
      "onConflict",
      "onConflict must be error or resolve",
    )
  }

  const inbox = await findOrFail({
    table: inboxModel,
    where: { workspaceId, id: inboxId },
    message: "Inbox not found",
  })
  if (inbox.channel !== channelTypes.enum.api) {
    throw validationException(
      "inboxId",
      "Only api-channel inboxes can be attached to an existing contact",
    )
  }

  const contact = await contactService.findByIdOrFail({
    workspaceId,
    id: contactId,
  })

  const explicitSourceId = input.sourceId?.trim()
  let sourceId: string
  if (explicitSourceId && !PHONE_SHAPED_PATTERN.test(explicitSourceId)) {
    sourceId = explicitSourceId
  } else {
    const phone = explicitSourceId ?? contact.phoneNumber
    if (!phone) {
      throw validationException(
        "sourceId",
        "Contact has no phone number; pass sourceId explicitly",
      )
    }
    const workspace = await workspaceService.find({
      where: { id: workspaceId },
    })
    const parsed = parsePhoneNumberFromString(
      phone,
      resolveDefaultRegion(workspace?.targetCountry),
    )
    // Do not use isValid(); it rejects well-formed but unassigned numbers.
    if (!parsed) {
      throw validationException(
        explicitSourceId ? "sourceId" : "phoneNumber",
        "Please include the country code (e.g. +84)",
      )
    }
    sourceId = parsed.number
  }

  // `onConflict: "resolve"`: hand back the owner instead of throwing. The
  // owner's DM conversation is ensured (read-or-create, the same call the
  // inbound path makes) so `resolveContactInboxForSend` finds it; no
  // ContactInbox is written and no contact event fires.
  const resolveConflict = async (row: ContactInboxModel) => {
    const conversation = await conversationService.findOrCreate({
      workspaceId,
      contactId: row.contactId,
      sourceId: null,
    })
    return {
      contactInbox: row,
      conversation,
      inbox,
      created: false,
      ownedByAnotherContact: true,
    }
  }

  const resolveOwner = (row: ContactInboxModel | undefined) => {
    if (!row) {
      return
    }
    if (row.contactId !== contact.id) {
      throw ownedByAnotherContact()
    }
    return row
  }

  const preCheck = await contactInboxService.findLatestBySource({
    inboxId: inbox.id,
    sourceId,
    workspaceId,
  })
  if (
    preCheck &&
    preCheck.contactId !== contact.id &&
    onConflict === "resolve"
  ) {
    return resolveConflict(preCheck)
  }
  const existing = resolveOwner(preCheck)

  type TxResult =
    | { lostTo: ContactInboxModel }
    | {
        contactInbox: ContactInboxModel
        conversation: ConversationModel
        created: boolean
      }
  const result = await db.transaction(async (tx): Promise<TxResult> => {
    let contactInbox = existing
    let created = false
    if (!contactInbox) {
      // Targetless DO NOTHING: a concurrent attach or inbound message may
      // have inserted the same (inboxId, sourceId) between the read above and
      // this write; re-select and apply the same owner rule.
      const [inserted] = await tx
        .insert(contactInboxModel)
        .values({
          originalContactId: contact.id,
          contactId: contact.id,
          inboxId: inbox.id,
          channel: inbox.channel,
          source: contactSources.enum.api,
          sourceId,
        })
        .onConflictDoNothing()
        .returning()
      if (inserted) {
        contactInbox = inserted
        created = true
        // A re-created identity keeps its history: cancel any pending
        // message cleanup recorded when a row with this identity was deleted.
        await messageCleanupService.cancelByInboxSource({
          inboxId: inbox.id,
          sourceIds: [sourceId],
          tx,
        })
      } else {
        const raced = await contactInboxService.findLatestBySource({
          tx,
          inboxId: inbox.id,
          sourceId,
          workspaceId,
        })
        if (
          raced &&
          raced.contactId !== contact.id &&
          onConflict === "resolve"
        ) {
          return { lostTo: raced }
        }
        contactInbox = resolveOwner(raced)
        if (!contactInbox) {
          throw new ChatbotXException("Contact inbox not found")
        }
      }
    }

    if (!contactInbox) {
      throw new ChatbotXException("Contact inbox not found")
    }

    const conversation = await conversationService.findOrCreate({
      workspaceId,
      contactId: contact.id,
      sourceId: null,
      tx,
    })

    return { contactInbox, conversation, created }
  })
  if ("lostTo" in result) {
    return resolveConflict(result.lostTo)
  }

  if (result.created) {
    await contactInboxService.invalidateTracking({
      cacheTags: [`contacts:${contact.id}:contact-inboxes`],
    })
    await dispatchAuditRecord({
      workspaceId,
      action: "update",
      detail: `attached contact (#${contact.id}) to inbox (#${inbox.id})`,
    })
  }

  return { ...result, inbox, ownedByAnotherContact: false }
}
