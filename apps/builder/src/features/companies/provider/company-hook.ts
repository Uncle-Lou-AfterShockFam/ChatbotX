import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useMemo } from "react"
import { useWorkspaceId } from "@/hooks/routing"
import { client } from "@/lib/orpc/orpc"
import { orpc } from "@/lib/orpc/query"
import { fetchAllListPages } from "@/lib/query/fetch-all-list-pages"

export const useCompanies = (
  workspaceId: string | undefined,
  options?: { enabled?: boolean },
) =>
  useQuery({
    // Every page, not one call the server caps at 50 rows (s205). The key
    // stays under `orpc.companiesAPI.key()` so invalidation still reaches it.
    queryKey: orpc.companiesAPI.privateListWorkspaceCompaniesAPI.key({
      type: "query",
      input: { workspaceId: workspaceId ?? "" },
    }),
    queryFn: ({ signal }) =>
      fetchAllListPages(
        (page) =>
          client.companiesAPI.privateListWorkspaceCompaniesAPI(
            {
              workspaceId: workspaceId ?? "",
              ...page,
            },
            { signal },
          ),
        { desc: true },
      ),
    enabled: Boolean(workspaceId) && (options?.enabled ?? true),
  })

/** Call after create/update/delete/stop so every reader refetches. */
export const useInvalidateCompanies = () => {
  const queryClient = useQueryClient()
  return () =>
    queryClient.invalidateQueries({ queryKey: orpc.companiesAPI.key() })
}

export const useCompanySelectOptions = (options?: {
  enabled?: boolean
}): { label: string; value: string; stopped: boolean }[] => {
  const workspaceId = useWorkspaceId()
  const { data } = useCompanies(workspaceId, options)

  return useMemo(
    () =>
      (data ?? []).map((company) => ({
        label: company.name,
        value: company.id,
        stopped: company.stoppedAt !== null,
      })),
    [data],
  )
}
