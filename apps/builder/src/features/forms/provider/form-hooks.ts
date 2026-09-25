import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { useCallback } from "react"
import { orpc } from "@/lib/orpc/query"

/** Forms data (s200): list, one form, submissions, and the editor's mutations. */

export const useForms = (workspaceId: string, includeArchived = false) =>
  useQuery(
    orpc.formsAPI.privateListFormsAPI.queryOptions({
      input: { workspaceId, includeArchived },
      select: (res) => res.data,
    }),
  )

export const useForm = (workspaceId: string, id: string) =>
  useQuery(
    orpc.formsAPI.privateGetFormAPI.queryOptions({
      input: { workspaceId, id },
    }),
  )

export const useInvalidateForms = () => {
  const queryClient = useQueryClient()
  return useCallback(
    () => queryClient.invalidateQueries({ queryKey: orpc.formsAPI.key() }),
    [queryClient],
  )
}

export const useCreateForm = () => {
  const invalidate = useInvalidateForms()
  return useMutation(
    orpc.formsAPI.privateCreateFormAPI.mutationOptions({
      onSettled: () => invalidate(),
    }),
  )
}

export const useUpdateForm = () => {
  const invalidate = useInvalidateForms()
  return useMutation(
    orpc.formsAPI.privateUpdateFormAPI.mutationOptions({
      onSettled: () => invalidate(),
    }),
  )
}

export const usePublishForm = () => {
  const invalidate = useInvalidateForms()
  return useMutation(
    orpc.formsAPI.privatePublishFormAPI.mutationOptions({
      onSettled: () => invalidate(),
    }),
  )
}

export const useSetFormStatus = () => {
  const invalidate = useInvalidateForms()
  return useMutation(
    orpc.formsAPI.privateSetFormStatusAPI.mutationOptions({
      onSettled: () => invalidate(),
    }),
  )
}

export const useDuplicateForm = () => {
  const invalidate = useInvalidateForms()
  return useMutation(
    orpc.formsAPI.privateDuplicateFormAPI.mutationOptions({
      onSettled: () => invalidate(),
    }),
  )
}

export const useDeleteForm = () => {
  const invalidate = useInvalidateForms()
  return useMutation(
    orpc.formsAPI.privateDeleteFormAPI.mutationOptions({
      onSettled: () => invalidate(),
    }),
  )
}

export const useFormSubmissions = (workspaceId: string, id: string) =>
  useInfiniteQuery(
    orpc.formsAPI.privateListFormSubmissionsAPI.infiniteOptions({
      input: (cursor: string | undefined) => ({
        workspaceId,
        id,
        cursor,
        limit: 50,
      }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    }),
  )

export const useDeleteFormSubmission = () => {
  const invalidate = useInvalidateForms()
  return useMutation(
    orpc.formsAPI.privateDeleteFormSubmissionAPI.mutationOptions({
      onSettled: () => invalidate(),
    }),
  )
}
