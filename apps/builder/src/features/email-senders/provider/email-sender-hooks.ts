import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback } from "react"
import { orpc } from "@/lib/orpc/query"

/** react-query hooks for the mailbox senders (ManyReach step 3, s229b). */

export const useEmailSenders = (workspaceId: string) =>
  useQuery(
    orpc.emailSenderAPI.privateListEmailSendersAPI.queryOptions({
      input: { workspaceId },
    }),
  )

const useInvalidateEmailSenders = () => {
  const queryClient = useQueryClient()
  return useCallback(
    () =>
      queryClient.invalidateQueries({
        queryKey: orpc.emailSenderAPI.privateListEmailSendersAPI.key(),
      }),
    [queryClient],
  )
}

export const useCreateEmailSender = () => {
  const invalidate = useInvalidateEmailSenders()
  return useMutation(
    orpc.emailSenderAPI.privateCreateEmailSenderAPI.mutationOptions({
      onSettled: () => invalidate(),
    }),
  )
}

export const useUpdateEmailSender = () => {
  const invalidate = useInvalidateEmailSenders()
  return useMutation(
    orpc.emailSenderAPI.privateUpdateEmailSenderAPI.mutationOptions({
      onSettled: () => invalidate(),
    }),
  )
}

export const useSetEmailSenderStatus = () => {
  const invalidate = useInvalidateEmailSenders()
  return useMutation(
    orpc.emailSenderAPI.privateSetEmailSenderStatusAPI.mutationOptions({
      onSettled: () => invalidate(),
    }),
  )
}

export const useArchiveEmailSender = () => {
  const invalidate = useInvalidateEmailSenders()
  return useMutation(
    orpc.emailSenderAPI.privateArchiveEmailSenderAPI.mutationOptions({
      onSettled: () => invalidate(),
    }),
  )
}
