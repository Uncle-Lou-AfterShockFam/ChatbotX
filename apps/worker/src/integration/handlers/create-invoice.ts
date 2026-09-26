import { createHash } from "node:crypto"
import {
  InvoiceFinalizeError,
  invoiceService,
  markInvoiceCreated,
} from "@chatbotx.io/business/invoice"
import type { CreateInvoiceStepSchema } from "@chatbotx.io/flow-config"
import { contactVariableService } from "@chatbotx.io/variables"
import { logger } from "../../lib/logger"
import type { ExecuteStepProps } from "./flow-utils"
import type { ExecuteStepResult } from "./step"

/**
 * One invoice per (flow run, step): the source key is derived from the run
 * key, so a BullMQ retry or a re-entered step returns the same invoice (and
 * resumes a draft whose Stripe finalize failed) instead of billing twice.
 */
export const invoiceSourceKey = (flowExecutionKey: string, stepId: string) =>
  `flow:${createHash("sha256")
    .update(JSON.stringify([flowExecutionKey, stepId]))
    .digest("hex")
    .slice(0, 40)}`

const error = (errorMessage: string): ExecuteStepResult => ({
  status: "error",
  errorMessage,
  result: null,
})

export async function handleCreateInvoice({
  conversation,
  contactInbox,
  step,
  flowExecutionKey,
}: ExecuteStepProps<CreateInvoiceStepSchema>): Promise<ExecuteStepResult> {
  const { workspaceId, contactId } = conversation
  if (step.lines.length === 0) {
    return error("The invoice has no line items")
  }
  // Without a run key every retry would bill again: refuse instead.
  if (!flowExecutionKey) {
    return error("Flow run has no execution key")
  }
  try {
    const variables = await contactVariableService.getAll({
      contactId,
      contactInbox,
      conversation,
    })
    const render = (text: string) =>
      contactVariableService.replaceAll({ text, variables })
    const lines = await Promise.all(
      step.lines.map(async (line, index) => ({
        description:
          (await render(line.description)).trim() || `Item ${index + 1}`,
        quantity: line.quantity,
        unitAmount: (await render(line.unitAmount)).trim(),
      })),
    )
    const memo = (await render(step.memo)).trim()
    const invoice = await invoiceService.create({
      workspaceId,
      contactId,
      currency: step.currency,
      lines,
      dueDays: step.dueInDays,
      ...(memo ? { memo: memo.slice(0, 1000) } : {}),
      sourceKey: invoiceSourceKey(flowExecutionKey, step.id),
    })
    await markInvoiceCreated({ invoice, contactInboxId: contactInbox.id })
    return {
      status: "success",
      result: {
        invoiceId: invoice.id,
        number: invoice.number,
        status: invoice.status,
        total: invoice.total,
        currency: invoice.currency,
        hostedUrl: invoice.hostedUrl,
      },
    }
  } catch (caught) {
    const retryable =
      caught instanceof InvoiceFinalizeError ? caught.retryable : undefined
    logger.warn(
      { err: caught, workspaceId, contactId, stepId: step.id, retryable },
      "createInvoice failed",
    )
    return error(
      caught instanceof Error ? caught.message : "createInvoice failed",
    )
  }
}
