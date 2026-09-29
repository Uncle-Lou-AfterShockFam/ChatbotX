import { createId, zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"
import {
  skipStateDefaultFn,
  skipStateSchema,
  successStateDefaultFn,
  successStateSchema,
} from "../states"
import { stepTypes } from "./step-action"

export const ASK_FORM_MAX_TIMEOUT_MINUTES = 30 * 24 * 60
export const ASK_FORM_MAX_ATTEMPTS = 10

/**
 * Ask a published form in the conversation, one question per message (s219
 * A2-2). `success` = the answers were submitted (FormSubmission channel chat,
 * `formSubmitted`); `skip` = the form is not available for chat, the contact
 * exhausted `maxAttempts` on a question, or no reply came within
 * `timeoutMinutes` of the last question.
 */
export const askFormStepSchema = z.object({
  id: zodBigintAsString(),
  stepType: z.literal(stepTypes.enum.askForm),
  formId: z.string().regex(/^\d{1,19}$/, "Pick a form."),
  timeoutMinutes: z.coerce
    .number()
    .int()
    .min(1)
    .max(ASK_FORM_MAX_TIMEOUT_MINUTES),
  maxAttempts: z.coerce.number().int().min(1).max(ASK_FORM_MAX_ATTEMPTS),
  /** Sent before re-asking when an answer does not fit; a field's own chat retry wins. */
  retryMessage: z.string().trim().max(255),
  states: z.tuple([successStateSchema, skipStateSchema]),
})
export type AskFormStepSchema = z.infer<typeof askFormStepSchema>

export const askFormStepDefaultFn = (): AskFormStepSchema => ({
  id: createId(),
  stepType: stepTypes.enum.askForm,
  formId: "",
  timeoutMinutes: 1440,
  maxAttempts: 3,
  retryMessage: "",
  states: [successStateDefaultFn(), skipStateDefaultFn()],
})
