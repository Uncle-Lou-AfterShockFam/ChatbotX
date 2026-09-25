import { createHash } from "node:crypto"
import {
  contactCustomFieldService,
  contactService,
  customFieldService,
} from "@chatbotx.io/business"
import {
  documentSigningService,
  SIG_DOC_ID_FIELD,
  SIG_LINK_FIELD,
} from "@chatbotx.io/business/documents"
import type { SendDocumentForSignatureStepSchema } from "@chatbotx.io/flow-config"
import { customFieldResolutionKey } from "@chatbotx.io/utils/custom-field"
import { contactDocumentVariables } from "@chatbotx.io/variables"
import { logger } from "../../lib/logger"
import type { ExecuteStepProps } from "./flow-utils"
import type { ExecuteStepResult } from "./step"

/**
 * One document per (flow run, step): the ref is derived from the run key, so
 * a BullMQ retry of this step reuses the same document and envelope instead
 * of sending a second one. Hashed because a run key is not ref-safe.
 */
const MAX_SIGNER_NAME = 100

export const signatureRef = (flowExecutionKey: string, stepId: string) =>
  `sig:${createHash("sha256")
    .update(JSON.stringify([flowExecutionKey, stepId]))
    .digest("hex")
    .slice(0, 40)}`

export async function handleSendDocumentForSignature({
  conversation,
  contactInbox,
  step,
  flowExecutionKey,
}: ExecuteStepProps<SendDocumentForSignatureStepSchema>): Promise<ExecuteStepResult> {
  const { workspaceId, contactId } = conversation
  if (!step.templateId) {
    return {
      status: "error",
      errorMessage: "No document template picked",
      result: null,
    }
  }
  // Without a run key every retry would open a new document: refuse instead.
  if (!flowExecutionKey) {
    return {
      status: "error",
      errorMessage: "Flow run has no execution key",
      result: null,
    }
  }
  try {
    const contact = await contactService.findByIdOrFail({
      workspaceId,
      id: contactId,
    })
    const signed = await documentSigningService.sendForSignature({
      workspaceId,
      contactId,
      templateId: step.templateId,
      ref: signatureRef(flowExecutionKey, step.id),
      signerName:
        contact.fullName?.trim().slice(0, MAX_SIGNER_NAME) || "Signer",
      resolveVariables: contactDocumentVariables(contactId),
    })
    if (!signed.ok) {
      logger.warn(
        { workspaceId, contactId, stepId: step.id, stage: signed.stage },
        `sendDocumentForSignature failed: ${signed.error}`,
      )
      return {
        status: "error",
        errorMessage: `${signed.stage}: ${signed.error}`,
        result: null,
      }
    }

    const fields = [
      { name: SIG_LINK_FIELD, type: "shortText" as const },
      { name: SIG_DOC_ID_FIELD, type: "shortText" as const },
    ]
    const { idMap } = await customFieldService.resolveByNameAndType({
      workspaceId,
      fields,
    })
    const writes: [(typeof fields)[number], string][] = [
      [fields[0], signed.signingUrl],
      [fields[1], String(signed.documensoDocumentId)],
    ]
    for (const [field, value] of writes) {
      await contactCustomFieldService.setValueByKey({
        workspaceId,
        contactId,
        keyword: idMap.get(customFieldResolutionKey(field)) ?? field.name,
        value,
        contactInboxId: contactInbox.id,
      })
    }
    return {
      status: "success",
      result: {
        documentId: signed.document.id,
        documensoDocumentId: signed.documensoDocumentId,
        reused: signed.reused,
      },
    }
  } catch (error) {
    logger.error(
      { err: error, workspaceId, contactId, stepId: step.id },
      "sendDocumentForSignature threw",
    )
    return {
      status: "error",
      errorMessage:
        error instanceof Error
          ? error.message
          : "sendDocumentForSignature failed",
      result: null,
    }
  }
}
