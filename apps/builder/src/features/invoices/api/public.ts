import { invoiceService } from "@chatbotx.io/business/invoice"
import {
  possibleErrorsOnCreatingResource,
  possibleErrorsOnFindingResource,
  possibleErrorsOnListingResource,
  possibleErrorsOnMutatingResource,
} from "@/lib/orpc/orpc-error-helper"
import { workspaceTokenAuthAPIForScope } from "@/orpc"
import {
  createInvoiceRequest,
  invoiceDetailResource,
  invoiceIdInput,
  listInvoicesRequest,
  listInvoicesResponse,
  toInvoiceResource,
} from "../schema/resource"

const workspaceTokenAuthAPI = workspaceTokenAuthAPIForScope("ecommerce")

const toDetail = (row: Awaited<ReturnType<typeof invoiceService.get>>) => ({
  ...toInvoiceResource(row),
  lineItems: row.lineItems.map((line) => ({
    position: line.position,
    description: line.description,
    quantity: line.quantity,
    unitAmount: line.unitAmount,
    amount: line.amount,
  })),
})

export const invoicesPublicRouter = {
  list: workspaceTokenAuthAPI
    .route({
      method: "GET",
      path: "/v1/invoices",
      summary: "List invoices",
      description:
        "Returns invoices in this workspace, newest first, optionally for one contact or status. Page with `limit` and the returned `nextCursor`.",
      tags: ["Invoices"],
    })
    .input(listInvoicesRequest)
    .output(listInvoicesResponse)
    .errors(possibleErrorsOnListingResource)
    .handler(async ({ context, input }) => {
      const page = await invoiceService.list({
        ...input,
        workspaceId: context.workspace.id,
      })
      return {
        data: page.data.map(toInvoiceResource),
        nextCursor: page.nextCursor,
      }
    }),

  get: workspaceTokenAuthAPI
    .route({
      method: "GET",
      path: "/v1/invoices/{id}",
      summary: "Get invoice",
      description:
        "Returns one invoice with its line items, status, totals and the Stripe pay link when it is open.",
      tags: ["Invoices"],
    })
    .input(invoiceIdInput)
    .output(invoiceDetailResource)
    .errors(possibleErrorsOnFindingResource)
    .handler(async ({ context, input }) =>
      toDetail(
        await invoiceService.get({
          workspaceId: context.workspace.id,
          id: input.id,
        }),
      ),
    ),

  create: workspaceTokenAuthAPI
    .route({
      method: "POST",
      path: "/v1/invoices",
      summary: "Create invoice",
      description:
        'Invoices a contact through the workspace\'s connected Stripe account and returns it with its pay link (`hostedUrl`). Amounts are strings in major units (`"25.00"`). Send `idempotencyKey` to make a retry safe: the same key returns the first invoice.',
      tags: ["Invoices"],
    })
    .input(createInvoiceRequest)
    .output(invoiceDetailResource)
    .errors(possibleErrorsOnCreatingResource)
    .handler(async ({ context, input }) =>
      toDetail(
        await invoiceService.create({
          workspaceId: context.workspace.id,
          contactId: input.contactId,
          currency: input.currency,
          lines: input.lines,
          dueDays: input.dueInDays,
          memo: input.memo,
          dealId: input.dealId,
          sourceKey: input.idempotencyKey
            ? `api:${input.idempotencyKey}`
            : undefined,
        }),
      ),
    ),

  void: workspaceTokenAuthAPI
    .route({
      method: "POST",
      path: "/v1/invoices/{id}/void",
      summary: "Void invoice",
      description:
        "Voids an unpaid invoice here and at Stripe. A paid invoice cannot be voided.",
      tags: ["Invoices"],
    })
    .input(invoiceIdInput)
    .output(invoiceDetailResource)
    .errors(possibleErrorsOnMutatingResource)
    .handler(async ({ context, input }) =>
      toDetail(
        await invoiceService.void({
          workspaceId: context.workspace.id,
          id: input.id,
        }),
      ),
    ),
}
