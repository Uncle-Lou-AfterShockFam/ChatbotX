import { getIdFromParams } from "@chatbotx.io/utils"
import { notFound } from "next/navigation"
import { DealsBoard } from "@/features/deals/deals-board"
import { listPipelinesRSC } from "@/features/pipelines/queries"
import { requireContactsAccess } from "@/lib/auth/require-workspace-permission"

export default async function DealsPage(props: {
  params: Promise<{ workspaceId: string }>
}) {
  const workspaceId = getIdFromParams(await props.params, "workspaceId")
  if (!workspaceId) {
    return notFound()
  }
  await requireContactsAccess(workspaceId)

  const pipelines = await listPipelinesRSC({ workspaceId })

  return <DealsBoard pipelines={pipelines} workspaceId={workspaceId} />
}
