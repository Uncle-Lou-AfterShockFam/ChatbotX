import z from "zod"
import { contactInfoUpdated } from "./contact-info-updated"
import { customFieldValueChanged } from "./custom-field-value-changed"
import { dateTimeBasedTrigger } from "./date-time-based-trigger"
import {
  dealMentioned,
  taskAssigned,
  taskCompleted,
  taskCreated,
  taskOverdue,
  ticketCreated,
  ticketMovedToStage,
  ticketPriorityChanged,
  ticketStatusChanged,
  ticketValueChanged,
} from "./deal-conditions"
import { formSubmitted } from "./form-conditions"
import {
  invoiceCreated,
  invoicePaid,
  invoicePaymentFailed,
} from "./invoice-conditions"
import {
  archived,
  contactReferredANewContact,
  contactReferredExistingContact,
  contactUnsubscribedFormBroadcast,
  conversationAssigned,
  conversationTransferredToBot,
  conversationTransferredToHuman,
  conversationUnassigned,
  followUp,
  newContact,
  subscribedToSequence,
  unsubscribedFromSequence,
} from "./simple-conditions"
import { tagApplied } from "./tag-applied"
import { tagRemoved } from "./tag-removed"

export const allConditions = {
  tagApplied,
  tagRemoved,
  customFieldValueChanged,
  contactInfoUpdated,
  dateTimeBasedTrigger,
  conversationTransferredToHuman,
  conversationTransferredToBot,
  newContact,
  contactUnsubscribedFormBroadcast,
  archived,
  followUp,
  conversationAssigned,
  conversationUnassigned,
  subscribedToSequence,
  unsubscribedFromSequence,
  contactReferredANewContact,
  contactReferredExistingContact,
  ticketCreated,
  ticketMovedToStage,
  ticketValueChanged,
  ticketStatusChanged,
  ticketPriorityChanged,
  taskCreated,
  taskCompleted,
  taskOverdue,
  taskAssigned,
  dealMentioned,
  formSubmitted,
  invoiceCreated,
  invoicePaid,
  invoicePaymentFailed,
}

export const conditionSchema = z.union(Object.values(allConditions))
export type ConditionInput = z.infer<typeof conditionSchema>
