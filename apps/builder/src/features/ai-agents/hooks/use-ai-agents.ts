import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useMemo } from "react"
import { client } from "@/lib/orpc/orpc"
import { orpc } from "@/lib/orpc/query"
import { fetchAllListPages } from "@/lib/query/fetch-all-list-pages"

export const useAIAgents = (workspaceId: string | undefined) =>
  useQuery({
    // Every page, not one call the server caps at 50 rows (s205). The key
    // stays under `orpc.aiAgentsAPI.key()` so invalidation still reaches it.
    queryKey: orpc.aiAgentsAPI.listAIAgentsAPI.key({
      type: "query",
      input: { workspaceId: workspaceId ?? "" },
    }),
    queryFn: () =>
      fetchAllListPages((page) =>
        client.aiAgentsAPI.listAIAgentsAPI({
          workspaceId: workspaceId ?? "",
          ...page,
        }),
      ),
    enabled: Boolean(workspaceId),
  })

/** `{value,label}` pairs — the shape all consumers build by hand. */
export const useAIAgentSelectOptions = (workspaceId: string | undefined) => {
  const { data, isError } = useAIAgents(workspaceId)

  const options = useMemo(
    () =>
      (data ?? []).map((agent) => ({
        // `id` is a drizzle-zod custom-type column (bigintAsString) that
        // infers as `unknown`; it is always a string at runtime.
        value: agent.id as string,
        label: agent.name,
      })),
    [data],
  )

  return { options, isError }
}

/** Call after create/update/delete/change-default so every reader refetches. */
export const useInvalidateAIAgents = () => {
  const queryClient = useQueryClient()

  return () =>
    queryClient.invalidateQueries({ queryKey: orpc.aiAgentsAPI.key() })
}
