import { getIdFromParams } from "@chatbotx.io/utils"
import { notFound } from "next/navigation"
import { InvoicesPage } from "@/features/invoices/invoices-page"
import { requireContactsAccess } from "@/lib/auth/require-workspace-permission"

export default async function WorkspaceInvoicesPage(props: {
  params: Promise<{ workspaceId: string }>
}) {
  const workspaceId = getIdFromParams(await props.params, "workspaceId")
  if (!workspaceId) {
    return notFound()
  }
  await requireContactsAccess(workspaceId)
  return <InvoicesPage workspaceId={workspaceId} />
}
