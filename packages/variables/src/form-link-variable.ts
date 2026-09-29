import { resolveTenantSettings } from "@chatbotx.io/business"
import { formService } from "@chatbotx.io/business/form"
import type { ReplaceVariableProps } from "./schema"

/** `{{form_link:<formId>}}`: this contact's personal link to a web form (s220c A2-4). */
export const FORM_LINK_VARIABLE_PREFIX = "form_link:"
const FORM_ID_RE = /^\d{1,19}$/

export const isFormLinkVariable = (variable: string): boolean =>
  variable.startsWith(FORM_LINK_VARIABLE_PREFIX)

export const getFormLinkVariableFormId = (variable: string): string | null => {
  if (!isFormLinkVariable(variable)) {
    return null
  }
  const formId = variable.slice(FORM_LINK_VARIABLE_PREFIX.length).trim()
  return FORM_ID_RE.test(formId) ? formId : null
}

/**
 * Mints the link at SEND time, per contact: "" when the form is not served
 * on the web (draft, archived, chat-only, deleted) or the contact is unknown,
 * so a message never carries a dead or foreign link.
 */
export const resolveFormLinkVariable = async (
  variables: ReplaceVariableProps,
  variable: string,
): Promise<string> => {
  const formId = getFormLinkVariableFormId(variable)
  const workspaceId = variables.contact?.workspaceId
  const contactId = variables.contact?.id
  if (!(formId && workspaceId && contactId)) {
    return ""
  }
  const { appUrl } = await resolveTenantSettings({ workspaceId })
  return (
    (await formService.personalLink({
      workspaceId,
      formId,
      contactId,
      appUrl,
    })) ?? ""
  )
}
