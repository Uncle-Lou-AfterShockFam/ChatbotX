import { useQuery } from "@tanstack/react-query"
import { orpc } from "@/lib/orpc/query"

export const useDealComments = (
  workspaceId: string,
  dealId: string | null | undefined,
) =>
  useQuery(
    orpc.dealCommentsAPI.privateListDealCommentsAPI.queryOptions({
      input: { workspaceId, id: dealId ?? "" },
      enabled: Boolean(dealId),
      select: (res) => res.data,
    }),
  )
