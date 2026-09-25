import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useMemo } from "react"
import { orpc } from "@/lib/orpc/query"

export const useDealTasks = (
  workspaceId: string,
  dealId: string | null | undefined,
) =>
  useQuery(
    orpc.dealTasksAPI.privateListDealTasksAPI.queryOptions({
      input: { workspaceId, id: dealId ?? "" },
      enabled: Boolean(dealId),
      select: (res) => res.data,
    }),
  )

/** The task calendar's rows for `[from, to)` (s197). */
export const useTasksInRange = (
  workspaceId: string,
  query: {
    from: Date
    to: Date
    assignee: "me" | "any"
    status?: "open" | "done"
  },
) =>
  useQuery(
    orpc.dealTasksAPI.privateListTasksInRangeAPI.queryOptions({
      input: { workspaceId, ...query },
    }),
  )

export const usePipelineTaskTemplates = (
  workspaceId: string,
  pipelineId: string | null | undefined,
  options?: { enabled?: boolean },
) =>
  useQuery(
    orpc.dealTasksAPI.privateListPipelineTaskTemplatesAPI.queryOptions({
      input: { workspaceId, pipelineId: pipelineId ?? "" },
      enabled: Boolean(pipelineId) && (options?.enabled ?? true),
      select: (res) => res.data,
    }),
  )

/** Template options of a pipeline for the completeTask step picker. */
export const useTaskTemplateOptions = (
  workspaceId: string,
  pipelineId: string | null | undefined,
): { label: string; value: string }[] => {
  const { data } = usePipelineTaskTemplates(workspaceId, pipelineId)
  return useMemo(
    () => (data ?? []).map((tpl) => ({ label: tpl.title, value: tpl.id })),
    [data],
  )
}

export const useInvalidateDealTasks = () => {
  const queryClient = useQueryClient()
  return () =>
    queryClient.invalidateQueries({ queryKey: orpc.dealTasksAPI.key() })
}
