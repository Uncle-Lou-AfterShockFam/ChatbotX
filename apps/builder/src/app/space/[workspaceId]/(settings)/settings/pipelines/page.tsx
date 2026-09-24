import { getIdFromParams } from "@chatbotx.io/utils"
import { notFound } from "next/navigation"
import { PipelinesSettings } from "@/features/pipelines/pipelines-settings"
import { listPipelinesRSC } from "@/features/pipelines/queries"

export default async function PipelinesSettingsPage(props: {
  params: Promise<{ workspaceId: string }>
}) {
  const workspaceId = getIdFromParams(await props.params, "workspaceId")
  if (!workspaceId) {
    return notFound()
  }
  const pipelines = await listPipelinesRSC({ workspaceId })
  return <PipelinesSettings pipelines={pipelines} workspaceId={workspaceId} />
}
