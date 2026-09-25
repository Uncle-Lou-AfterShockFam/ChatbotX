import { getIdFromParams } from "@chatbotx.io/utils"
import { notFound } from "next/navigation"
import { FormsList } from "@/features/forms/components/forms-list"
import { requireContactsAccess } from "@/lib/auth/require-workspace-permission"

/** Web forms (s200): the workspace's forms, behind the contacts-section gate. */
export default async function FormsPage(props: {
  params: Promise<{ workspaceId: string }>
}) {
  const workspaceId = getIdFromParams(await props.params, "workspaceId")
  if (!workspaceId) {
    return notFound()
  }
  await requireContactsAccess(workspaceId)

  return <FormsList workspaceId={workspaceId} />
}
