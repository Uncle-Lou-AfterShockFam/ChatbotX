import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query"
import { useCallback } from "react"
import { orpc } from "@/lib/orpc/query"

/** react-query hooks for the email suppression list (outreach B-1, s224b). */

export const useEmailSuppressions = (workspaceId: string) =>
  useInfiniteQuery(
    orpc.emailSuppressionAPI.privateListEmailSuppressionsAPI.infiniteOptions({
      input: (cursor: string | null) => ({
        workspaceId,
        cursor: cursor ?? undefined,
      }),
      initialPageParam: null,
      getNextPageParam: (last) => last.nextCursor,
    }),
  )

const useInvalidateEmailSuppressions = () => {
  const queryClient = useQueryClient()
  return useCallback(
    () =>
      queryClient.invalidateQueries({
        queryKey:
          orpc.emailSuppressionAPI.privateListEmailSuppressionsAPI.key(),
      }),
    [queryClient],
  )
}

export const useAddEmailSuppression = () => {
  const invalidate = useInvalidateEmailSuppressions()
  return useMutation(
    orpc.emailSuppressionAPI.privateAddEmailSuppressionAPI.mutationOptions({
      onSettled: () => invalidate(),
    }),
  )
}

export const useRemoveEmailSuppression = () => {
  const invalidate = useInvalidateEmailSuppressions()
  return useMutation(
    orpc.emailSuppressionAPI.privateRemoveEmailSuppressionAPI.mutationOptions({
      onSettled: () => invalidate(),
    }),
  )
}
