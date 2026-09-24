import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useMemo } from "react"
import { orpc } from "@/lib/orpc/query"
import type { BoardStatusFilter } from "../schema/query"

export const useDealBoard = (
  workspaceId: string,
  pipelineId: string | null | undefined,
  status: BoardStatusFilter,
) =>
  useQuery(
    orpc.dealsAPI.privateGetDealBoardAPI.queryOptions({
      input: { workspaceId, pipelineId: pipelineId ?? "", status },
      enabled: Boolean(pipelineId),
      select: (res) => res.data,
    }),
  )

export const useDealActivities = (
  workspaceId: string,
  dealId: string | null | undefined,
) =>
  useQuery(
    orpc.dealsAPI.privateListDealActivitiesAPI.queryOptions({
      input: { workspaceId, id: dealId ?? "" },
      enabled: Boolean(dealId),
      select: (res) => res.data,
    }),
  )

/** Call after any deal write so the board and the drawer refetch. */
export const useInvalidateDeals = () => {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: orpc.dealsAPI.key() })
}

/** Workspace members as owner options (user id = value). */
export const useOwnerOptions = (
  workspaceId: string,
  options?: { enabled?: boolean },
): { label: string; value: string }[] => {
  const { data } = useQuery(
    orpc.workspaceMembersAPI.listWorkspaceMembersAuthenticatedAPI.queryOptions({
      input: { workspaceId, perPage: 100, page: 1 },
      enabled: options?.enabled ?? true,
      select: (res) => res.data,
    }),
  )
  return useMemo(
    () =>
      (data ?? []).map((member) => ({
        label: member.user.name ?? member.userId,
        value: member.userId,
      })),
    [data],
  )
}

/** Contacts matching a keyword for the create-deal dialog. */
export const useContactSearchOptions = (
  workspaceId: string,
  keyword: string,
  options?: { enabled?: boolean },
): { label: string; value: string }[] => {
  const { data } = useQuery(
    orpc.contactsAPIs.listContactsByPOSTAuthenticatedAPI.queryOptions({
      input: {
        workspaceId,
        keyword: keyword || undefined,
        perPage: 20,
        page: 1,
      },
      enabled: options?.enabled ?? true,
      select: (res) => res.data,
    }),
  )
  return useMemo(
    () =>
      (data ?? []).map((contact) => ({
        label:
          contact.fullName ||
          contact.email ||
          contact.phoneNumber ||
          contact.id,
        value: contact.id,
      })),
    [data],
  )
}
