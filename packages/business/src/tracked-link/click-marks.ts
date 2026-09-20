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

export type ClickMarkContactInbox = {
  id: string
  inboxId: string
  channel: string | null
}

export async function markBulktextClick(props: {
  workspaceId: string
  contactId: string
  contactInbox: ClickMarkContactInbox
  at: Date
}): Promise<void> {
  const { workspaceId, contactId, contactInbox, at } = props
  const field = { name: BULKTEXT_LAST_CLICK_FIELD, type: "shortText" as const }
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
    names: [BULKTEXT_CLICKED_TAG],
    contactInbox,
    emitFor: "newlyLinked",
  })
}
