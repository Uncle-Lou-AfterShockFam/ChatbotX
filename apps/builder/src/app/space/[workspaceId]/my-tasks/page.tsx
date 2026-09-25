import { getIdFromParams } from "@chatbotx.io/utils"
import { notFound } from "next/navigation"
import { MyTasks } from "@/features/deal-tasks/components/my-tasks"
import { requireContactsAccess } from "@/lib/auth/require-workspace-permission"

/** "My tasks" (s198): every task assigned to the caller, any date. */
export default async function MyTasksPage(props: {
  params: Promise<{ workspaceId: string }>
}) {
  const workspaceId = getIdFromParams(await props.params, "workspaceId")
  if (!workspaceId) {
    return notFound()
  }
  await requireContactsAccess(workspaceId)

  return <MyTasks workspaceId={workspaceId} />
}
