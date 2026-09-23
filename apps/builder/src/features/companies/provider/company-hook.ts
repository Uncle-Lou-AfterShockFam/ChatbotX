import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useMemo } from "react"
import { useWorkspaceId } from "@/hooks/routing"
import { orpc } from "@/lib/orpc/query"
import { maxPerPage } from "@/lib/shared-request"

export const useCompanies = (
  workspaceId: string | undefined,
  options?: { enabled?: boolean },
) =>
  useQuery(
    orpc.companiesAPI.privateListWorkspaceCompaniesAPI.queryOptions({
      input: { workspaceId: workspaceId ?? "", perPage: maxPerPage },
      enabled: Boolean(workspaceId) && (options?.enabled ?? true),
      select: (res) => res.data,
    }),
  )

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
