import { createId, zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"
import {
  errorStateDefaultFn,
  errorStateSchema,
  successStateDefaultFn,
  successStateSchema,
} from "../states"
import { stepTypes } from "./step-action"

/**
 * Render a document template for the contact and send it for signature with
 * Documenso (roadmap B6). Success writes the signing link to the contact
 * field `sig_link` (and the Documenso id to `sig_doc_id`) for a following
 * text step; completion tags the contact `doc-signed`, so a `wait` step on
 * that tag resumes. Error: not configured, render/Documenso failure, or no
 * template picked.
 */
export const sendDocumentForSignatureStepSchema = z.object({
  id: zodBigintAsString(),
  stepType: z.literal(stepTypes.enum.sendDocumentForSignature),
  templateId: z.string().optional(),
  states: z.tuple([successStateSchema, errorStateSchema]),
})
export type SendDocumentForSignatureStepSchema = z.infer<
  typeof sendDocumentForSignatureStepSchema
>

export const sendDocumentForSignatureStepDefaultFn =
  (): SendDocumentForSignatureStepSchema => ({
    id: createId(),
    stepType: stepTypes.enum.sendDocumentForSignature,
    templateId: undefined,
    states: [successStateDefaultFn(), errorStateDefaultFn()],
  })
