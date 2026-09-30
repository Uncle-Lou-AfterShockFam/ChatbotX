import { contactVariableService } from "@chatbotx.io/variables"

/**
 * Outreach B-1 H3 (s227b): the step's `holdOnMissing` fields that have no
 * value for this contact, resolved exactly as a merge field would be
 * (system fields, custom fields by name). Empty = nothing to hold.
 */
export async function missingHoldFields(props: {
  holdOnMissing: readonly string[] | null | undefined
  contactId: string
  contactInboxId: string
}): Promise<string[]> {
  const fields = props.holdOnMissing ?? []
  if (fields.length === 0) {
    return []
  }
  const variables = await contactVariableService.getAll({
    contactId: props.contactId,
    contactInbox: props.contactInboxId,
  })
  const values = await contactVariableService.resolveMapping({
    text: fields.map((name) => `{{${name}}}`).join(" "),
    variables,
  })
  return fields.filter((name) => {
    const value = Object.hasOwn(values, name) ? values[name] : undefined
    return !(typeof value === "string" && value.trim() !== "")
  })
}
