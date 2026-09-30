import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback } from "react"
import { orpc } from "@/lib/orpc/query"

/** react-query hooks for custom pages (roadmap B4). */

export const usePages = (workspaceId: string, includeArchived = false) =>
  useQuery(
    orpc.pagesAPI.privateListPagesAPI.queryOptions({
      input: { workspaceId, includeArchived },
      select: (res) => res.data,
    }),
  )

const useInvalidatePages = () => {
  const queryClient = useQueryClient()
  return useCallback(
    () =>
      queryClient.invalidateQueries({
        queryKey: orpc.pagesAPI.privateListPagesAPI.key(),
      }),
    [queryClient],
  )
}

export const useCreatePage = () => {
  const invalidate = useInvalidatePages()
  return useMutation(
    orpc.pagesAPI.privateCreatePageAPI.mutationOptions({
      onSettled: () => invalidate(),
    }),
  )
}

export const useUpdatePage = () => {
  const invalidate = useInvalidatePages()
  return useMutation(
    orpc.pagesAPI.privateUpdatePageAPI.mutationOptions({
      onSettled: () => invalidate(),
    }),
  )
}

export const useSetPageStatus = () => {
  const invalidate = useInvalidatePages()
  return useMutation(
    orpc.pagesAPI.privateSetPageStatusAPI.mutationOptions({
      onSettled: () => invalidate(),
    }),
  )
}

export const useDeletePage = () => {
  const invalidate = useInvalidatePages()
  return useMutation(
    orpc.pagesAPI.privateDeletePageAPI.mutationOptions({
      onSettled: () => invalidate(),
    }),
  )
}

/** The server render of a draft as the public page (renderWeb). */
export const usePagePreview = (
  workspaceId: string,
  document: unknown,
  enabled: boolean,
  vars?: Record<string, string>,
) =>
  useQuery(
    orpc.pagesAPI.privatePreviewPageAPI.queryOptions({
      input: { workspaceId, document, vars },
      enabled,
      placeholderData: (previous) => previous,
      staleTime: Number.POSITIVE_INFINITY,
      retry: false,
    }),
  )
