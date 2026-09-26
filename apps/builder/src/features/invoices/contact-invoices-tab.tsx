"use client"

import { CreateInvoiceDialog } from "./components/create-invoice-dialog"
import { InvoiceList } from "./components/invoice-list"

/** Contact 360 > Invoices: bill the contact, see and void their invoices. */
export function ContactInvoicesTab({
  workspaceId,
  contactId,
}: {
  workspaceId: string
  contactId: string
}) {
  return (
    <div className="space-y-4">
      <CreateInvoiceDialog contactId={contactId} workspaceId={workspaceId} />
      <InvoiceList contactId={contactId} workspaceId={workspaceId} />
    </div>
  )
}
