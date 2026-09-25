import { getIdFromParams } from "@chatbotx.io/utils"
import { notFound } from "next/navigation"
import { TaskCalendar } from "@/features/deal-tasks/components/task-calendar"
import { requireContactsAccess } from "@/lib/auth/require-workspace-permission"

/** The workspace task calendar (s197): tasks due across every visible deal. */
export default async function TasksPage(props: {
  params: Promise<{ workspaceId: string }>
}) {
  const workspaceId = getIdFromParams(await props.params, "workspaceId")
  if (!workspaceId) {
    return notFound()
  }
  await requireContactsAccess(workspaceId)

  return <TaskCalendar workspaceId={workspaceId} />
}
