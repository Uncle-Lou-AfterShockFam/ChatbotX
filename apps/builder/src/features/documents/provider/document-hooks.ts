import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback } from "react"
import { orpc } from "@/lib/orpc/query"

/** react-query hooks for Documents (roadmap B3). */

export const useDocumentTemplates = (
  workspaceId: string,
  includeArchived = false,
) =>
  useQuery(
    orpc.documentsAPI.privateListDocumentTemplatesAPI.queryOptions({
      input: { workspaceId, includeArchived },
      select: (res) => res.data,
    }),
  )

export const useContactDocuments = (workspaceId: string, contactId: string) =>
  useQuery(
    orpc.documentsAPI.privateListContactDocumentsAPI.queryOptions({
      input: { workspaceId, contactId },
      select: (res) => res.data,
    }),
  )

export const useInvalidateDocuments = () => {
  const queryClient = useQueryClient()
  return useCallback(
    () => queryClient.invalidateQueries({ queryKey: orpc.documentsAPI.key() }),
    [queryClient],
  )
}

export const useCreateDocumentTemplate = () => {
  const invalidate = useInvalidateDocuments()
  return useMutation(
    orpc.documentsAPI.privateCreateDocumentTemplateAPI.mutationOptions({
      onSettled: () => invalidate(),
    }),
  )
}

export const useUpdateDocumentTemplate = () => {
  const invalidate = useInvalidateDocuments()
  return useMutation(
    orpc.documentsAPI.privateUpdateDocumentTemplateAPI.mutationOptions({
      onSettled: () => invalidate(),
    }),
  )
}

export const useSetDocumentTemplateStatus = () => {
  const invalidate = useInvalidateDocuments()
  return useMutation(
    orpc.documentsAPI.privateSetDocumentTemplateStatusAPI.mutationOptions({
      onSettled: () => invalidate(),
    }),
  )
}

export const useDeleteDocumentTemplate = () => {
  const invalidate = useInvalidateDocuments()
  return useMutation(
    orpc.documentsAPI.privateDeleteDocumentTemplateAPI.mutationOptions({
      onSettled: () => invalidate(),
    }),
  )
}

export const useGenerateContactDocument = () => {
  const invalidate = useInvalidateDocuments()
  return useMutation(
    orpc.documentsAPI.privateGenerateContactDocumentAPI.mutationOptions({
      onSettled: () => invalidate(),
    }),
  )
}
