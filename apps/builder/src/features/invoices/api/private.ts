import { crmTimelineService } from "@chatbotx.io/business"
import { invoiceService } from "@chatbotx.io/business/invoice"
import { requireContactPermissionScope } from "@/features/contacts/permissions"
import { withWorkspaceIdSchema } from "@/features/workspaces/schema/resource"
import { contactsAccessAuthorizedMiddleware } from "@/middlewares/auth"
import { authorizedAPI } from "@/orpc"
import {
  createInvoiceRequest,
  invoiceDetailResource,
  invoiceIdInput,
  listInvoicesRequest,
  listInvoicesResponse,
  toInvoiceDetailResource,
  toInvoiceResource,
} from "../schema/resource"

/**
 * Invoices (hub invoicing, s205b) behind the contacts-section gate AND the
 * member's assigned-only scope: a restricted member sees only invoices of
 * contacts assigned to them (404 otherwise, no existence leak).
 */
const tags = ["Invoices"]

const assignedOnly = async (workspaceId: string) =>
  (await requireContactPermissionScope(workspaceId)).restrictToAssignedUserId

const privateListInvoicesAPI = authorizedAPI
  .route({
    method: "GET",
    path: "/workspaces/{workspaceId}/invoices",
    summary: "List invoices",
    tags,
  })
  .input(withWorkspaceIdSchema.and(listInvoicesRequest))
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(listInvoicesResponse)
  .handler(async ({ input }) => {
    const page = await invoiceService.list({
      workspaceId: input.workspaceId,
      contactId: input.contactId,
      status: input.status,
      limit: input.limit,
      cursor: input.cursor,
      restrictToAssignedUserId: await assignedOnly(input.workspaceId),
    })
    return {
      data: page.data.map(toInvoiceResource),
      nextCursor: page.nextCursor,
    }
  })

const privateGetInvoiceAPI = authorizedAPI
  .route({
    method: "GET",
    path: "/workspaces/{workspaceId}/invoices/{id}",
    summary: "Get an invoice",
    tags,
  })
  .input(withWorkspaceIdSchema.and(invoiceIdInput))
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(invoiceDetailResource)
  .handler(async ({ input }) =>
    toInvoiceDetailResource(
      await invoiceService.get({
        workspaceId: input.workspaceId,
        id: input.id,
        restrictToAssignedUserId: await assignedOnly(input.workspaceId),
      }),
    ),
  )

const privateCreateInvoiceAPI = authorizedAPI
  .route({
    method: "POST",
    path: "/workspaces/{workspaceId}/invoices",
    summary: "Create an invoice",
    tags,
  })
  .input(withWorkspaceIdSchema.and(createInvoiceRequest))
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(invoiceDetailResource)
  .handler(async ({ input }) => {
    await crmTimelineService.assertContact({
      workspaceId: input.workspaceId,
      contactId: input.contactId,
      accessScope: await requireContactPermissionScope(input.workspaceId),
    })
    return toInvoiceDetailResource(
      await invoiceService.create({
        workspaceId: input.workspaceId,
        contactId: input.contactId,
        currency: input.currency,
        lines: input.lines,
        dueDays: input.dueInDays,
        memo: input.memo,
        dealId: input.dealId,
        method: input.method,
        sourceKey: input.idempotencyKey
          ? `ui:${input.idempotencyKey}`
          : undefined,
      }),
    )
  })

const privateVoidInvoiceAPI = authorizedAPI
  .route({
    method: "POST",
    path: "/workspaces/{workspaceId}/invoices/{id}/void",
    summary: "Void an invoice",
    tags,
  })
  .input(withWorkspaceIdSchema.and(invoiceIdInput))
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(invoiceDetailResource)
  .handler(async ({ input }) =>
    toInvoiceDetailResource(
      await invoiceService.void({
        workspaceId: input.workspaceId,
        id: input.id,
        restrictToAssignedUserId: await assignedOnly(input.workspaceId),
      }),
    ),
  )

const privateFinalizeInvoiceAPI = authorizedAPI
  .route({
    method: "POST",
    path: "/workspaces/{workspaceId}/invoices/{id}/finalize",
    summary: "Retry sending a draft invoice to Stripe",
    tags,
  })
  .input(withWorkspaceIdSchema.and(invoiceIdInput))
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(invoiceDetailResource)
  .handler(async ({ input }) =>
    toInvoiceDetailResource(
      await invoiceService.finalize({
        workspaceId: input.workspaceId,
        id: input.id,
        restrictToAssignedUserId: await assignedOnly(input.workspaceId),
      }),
    ),
  )

export const privateInvoicesAPI = {
  privateListInvoicesAPI,
  privateGetInvoiceAPI,
  privateCreateInvoiceAPI,
  privateVoidInvoiceAPI,
  privateFinalizeInvoiceAPI,
}
