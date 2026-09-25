import type { ResolveDocumentVariables } from "@chatbotx.io/business/documents"
import { contactVariableService } from "./contact-variable"

/**
 * The contact's values for a template's `{{variable}}` keys, through the same
 * resolvers message text uses (system fields, custom fields, bot fields). No
 * channel context: a document is rendered from the contact, not a thread.
 */
export const contactDocumentVariables =
  (contactId: string): ResolveDocumentVariables =>
  async (keys) => {
    if (keys.length === 0) {
      return {}
    }
    const variables = await contactVariableService.getAll({
      contactId,
      contactInbox: null,
    })
    return await contactVariableService.resolveMapping({
      text: keys.map((key) => `{{${key}}}`).join(" "),
      variables,
    })
  }
