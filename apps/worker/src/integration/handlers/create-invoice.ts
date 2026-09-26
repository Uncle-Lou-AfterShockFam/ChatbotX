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

const sha = (parts: unknown[], length: number) =>
  createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, length)

/**
 * `flow:<step of this flow, for this contact>:` - the prefix the 10-minute
 * reuse matches on. The key adds the run key, so a BullMQ retry of THIS job
 * returns the same invoice (and resumes a draft whose Stripe finalize
 * failed). A duplicated continuation job gets a NEW run key; the reuse window
 * catches it instead. Scoped by contact so a recycled job id (a Redis reset)
 * can never return another contact's invoice.
 */
export const invoiceSourcePrefix = (props: {
  flowId: string
  stepId: string
  contactId: string
}) => `flow:${sha([props.flowId, props.stepId, props.contactId], 32)}:`

export const invoiceSourceKey = (prefix: string, flowExecutionKey: string) =>
  `${prefix}${sha([flowExecutionKey], 40)}`

/** One invoice per flow step and contact inside this window (loops included). */
export const FLOW_INVOICE_REUSE_MS = 10 * 60 * 1000

const error = (errorMessage: string): ExecuteStepResult => ({
  status: "error",
  errorMessage,
  result: null,
})

export async function handleCreateInvoice({
  conversation,
  contactInbox,
  flowVersion,
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
    const sourcePrefix = invoiceSourcePrefix({
      flowId: flowVersion.flowId,
      stepId: step.id,
      contactId,
    })
    const invoice = await invoiceService.create({
      workspaceId,
      contactId,
      currency: step.currency,
      lines,
      dueDays: step.dueInDays,
      method: step.method,
      ...(memo ? { memo: memo.slice(0, 1000) } : {}),
      sourceKey: invoiceSourceKey(sourcePrefix, flowExecutionKey),
      reuseRecent: { sourcePrefix, withinMs: FLOW_INVOICE_REUSE_MS },
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
    // A failed Stripe step leaves a draft with lastError: the Invoices page
    // (or POST /v1/invoices/{id}/finalize) retries it; the flow takes its
    // error branch now rather than stall the run.
    logger.warn(
      {
        err: caught,
        workspaceId,
        contactId,
        stepId: step.id,
        retryable:
          caught instanceof InvoiceFinalizeError ? caught.retryable : undefined,
      },
      "createInvoice failed",
    )
    return error(
      caught instanceof Error ? caught.message : "createInvoice failed",
    )
  }
}
