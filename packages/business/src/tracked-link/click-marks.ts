import { customFieldResolutionKey } from "@chatbotx.io/utils/custom-field"
import { contactCustomFieldService } from "../contact-custom-field/service"
import { customFieldService } from "../custom-field/service"
import { tagService } from "../tag/service"

/**
 * What a recorded click writes onto the contact, so a flow can branch on it:
 * the tag `bt-clicked` (condition `tags in [...]`, trigger `tagApplied`) and
 * the custom field `bt_last_click` (ISO instant of the latest click). Same
 * shape as the bulktext verdict write-back in the worker
 * (`bt_verdict` / `bt_reason` / `bt-blocked`), which cannot be imported by a
 * builder route, hence this copy lives in the business package.
 */
export const BULKTEXT_CLICKED_TAG = "bt-clicked"
export const BULKTEXT_LAST_CLICK_FIELD = "bt_last_click"
/** An open pixel fetched: tag `bt-opened`, field `bt_last_open` (ISO instant). */
export const BULKTEXT_OPENED_TAG = "bt-opened"
export const BULKTEXT_LAST_OPEN_FIELD = "bt_last_open"

export type ClickMarkContactInbox = {
  id: string
  inboxId: string
  channel: string | null
}

async function markEngagement(props: {
  workspaceId: string
  contactId: string
  contactInbox: ClickMarkContactInbox
  at: Date
  fieldName: string
  tagName: string
}): Promise<void> {
  const { workspaceId, contactId, contactInbox, at } = props
  const field = { name: props.fieldName, type: "shortText" as const }
  const { idMap } = await customFieldService.resolveByNameAndType({
    workspaceId,
    fields: [field],
  })
  const keyword = idMap.get(customFieldResolutionKey(field)) ?? field.name
  await contactCustomFieldService.setValueByKey({
    workspaceId,
    contactId,
    keyword,
    value: at.toISOString(),
    contactInboxId: contactInbox.id,
  })
  await tagService.attachByNamesToContacts({
    workspaceId,
    contactIds: [contactId],
    names: [props.tagName],
    contactInbox,
    emitFor: "newlyLinked",
  })
}

export const markBulktextClick = (props: {
  workspaceId: string
  contactId: string
  contactInbox: ClickMarkContactInbox
  at: Date
}): Promise<void> =>
  markEngagement({
    ...props,
    fieldName: BULKTEXT_LAST_CLICK_FIELD,
    tagName: BULKTEXT_CLICKED_TAG,
  })

export const markBulktextOpen = (props: {
  workspaceId: string
  contactId: string
  contactInbox: ClickMarkContactInbox
  at: Date
}): Promise<void> =>
  markEngagement({
    ...props,
    fieldName: BULKTEXT_LAST_OPEN_FIELD,
    tagName: BULKTEXT_OPENED_TAG,
  })
