import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useMemo } from "react"
import { useWorkspaceId } from "@/hooks/routing"
import { orpc } from "@/lib/orpc/query"

export const usePipelines = (
  workspaceId: string | undefined,
  options?: { enabled?: boolean },
) =>
  useQuery(
    orpc.pipelinesAPI.privateListWorkspacePipelinesAPI.queryOptions({
      input: { workspaceId: workspaceId ?? "" },
      enabled: Boolean(workspaceId) && (options?.enabled ?? true),
      select: (res) => res.data,
    }),
  )

/** Call after any pipeline or stage write so every reader refetches. */
export const useInvalidatePipelines = () => {
  const queryClient = useQueryClient()
  return () =>
    queryClient.invalidateQueries({ queryKey: orpc.pipelinesAPI.key() })
}

export const usePipelineOptions = (): { label: string; value: string }[] => {
  const workspaceId = useWorkspaceId()
  const { data } = usePipelines(workspaceId)
  return useMemo(
    () => (data ?? []).map((p) => ({ label: p.name, value: p.id })),
    [data],
  )
}

/** Stages of one pipeline (empty until a pipeline is chosen). */
export const useStageOptions = (
  pipelineId: string | null | undefined,
): { label: string; value: string }[] => {
  const workspaceId = useWorkspaceId()
  const { data } = usePipelines(workspaceId)
  return useMemo(() => {
    const pipeline = (data ?? []).find((p) => p.id === pipelineId)
    return (pipeline?.stages ?? []).map((s) => ({ label: s.name, value: s.id }))
  }, [data, pipelineId])
}

/** Every stage, grouped by pipeline, for a condition pinned to a destination stage. */
export const useStageOptionsGroupedByPipeline = (): {
  label: string
  value: string
  children: { label: string; value: string }[]
}[] => {
  const workspaceId = useWorkspaceId()
  const { data } = usePipelines(workspaceId)
  return useMemo(
    () =>
      (data ?? [])
        .filter((p) => p.stages.length > 0)
        .map((p) => ({
          label: p.name,
          value: `pipeline:${p.id}`,
          children: p.stages.map((s) => ({
            label: `${p.name} / ${s.name}`,
            value: s.id,
          })),
        })),
    [data],
  )
}
