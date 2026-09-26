import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useMemo } from "react"
import { useWorkspaceId } from "@/hooks/routing"
import { client } from "@/lib/orpc/orpc"
import { orpc } from "@/lib/orpc/query"
import { fetchAllListPages } from "@/lib/query/fetch-all-list-pages"

export const useTags = (
  workspaceId: string | undefined,
  options?: { enabled?: boolean },
) =>
  useQuery({
    // Every page, not one call the server caps at 50 rows (s205). The key
    // stays under `orpc.tagsAPI.key()` so invalidation still reaches it.
    queryKey: orpc.tagsAPI.privateListWorkspaceTagsAPI.key({
      type: "query",
      input: { workspaceId: workspaceId ?? "" },
    }),
    queryFn: ({ signal }) =>
      fetchAllListPages((page) =>
        client.tagsAPI.privateListWorkspaceTagsAPI(
          {
            workspaceId: workspaceId ?? "",
            ...page,
          },
          { signal },
        ),
      ),
    enabled: Boolean(workspaceId) && (options?.enabled ?? true),
  })

/** Call after create/update/delete so every reader refetches. */
export const useInvalidateTags = () => {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: orpc.tagsAPI.key() })
}

export const useTagOptions = (): string[] => {
  const workspaceId = useWorkspaceId()
  const { data } = useTags(workspaceId)

  return useMemo(() => (data ?? []).map((tag) => tag.name), [data])
}

export const useTagSelectOptions = ({
  prefix,
}: {
  prefix?: string
} = {}): { label: string; value: string }[] => {
  const workspaceId = useWorkspaceId()
  const { data } = useTags(workspaceId)

  return useMemo(
    () =>
      (data ?? []).map((tag) => ({
        label: tag.name,
        value: prefix ? `${prefix}:${tag.id}` : tag.id,
      })),
    [data, prefix],
  )
}
