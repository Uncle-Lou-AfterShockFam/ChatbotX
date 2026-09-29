import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback } from "react"
import { orpc } from "@/lib/orpc/query"

/** react-query hooks for email templates (roadmap B2 phase 3). */

export const useEmailTemplates = (
  workspaceId: string,
  includeArchived = false,
) =>
  useQuery(
    orpc.emailTemplatesAPI.privateListEmailTemplatesAPI.queryOptions({
      input: { workspaceId, includeArchived },
      select: (res) => res.data,
    }),
  )

const useInvalidateEmailTemplates = () => {
  const queryClient = useQueryClient()
  return useCallback(
    () =>
      queryClient.invalidateQueries({
        queryKey: orpc.emailTemplatesAPI.privateListEmailTemplatesAPI.key(),
      }),
    [queryClient],
  )
}

export const useCreateEmailTemplate = () => {
  const invalidate = useInvalidateEmailTemplates()
  return useMutation(
    orpc.emailTemplatesAPI.privateCreateEmailTemplateAPI.mutationOptions({
      onSettled: () => invalidate(),
    }),
  )
}

export const useUpdateEmailTemplate = () => {
  const invalidate = useInvalidateEmailTemplates()
  return useMutation(
    orpc.emailTemplatesAPI.privateUpdateEmailTemplateAPI.mutationOptions({
      onSettled: () => invalidate(),
    }),
  )
}

export const useSetEmailTemplateStatus = () => {
  const invalidate = useInvalidateEmailTemplates()
  return useMutation(
    orpc.emailTemplatesAPI.privateSetEmailTemplateStatusAPI.mutationOptions({
      onSettled: () => invalidate(),
    }),
  )
}

export const useDeleteEmailTemplate = () => {
  const invalidate = useInvalidateEmailTemplates()
  return useMutation(
    orpc.emailTemplatesAPI.privateDeleteEmailTemplateAPI.mutationOptions({
      onSettled: () => invalidate(),
    }),
  )
}

/** The server render of a draft; keyed by its JSON so an unchanged draft is not re-rendered. */
export const useEmailTemplatePreview = (
  workspaceId: string,
  document: unknown,
  enabled: boolean,
  /** Sample merge values (lib/preview-samples.ts); part of the query key. */
  vars?: Record<string, string>,
) =>
  useQuery(
    orpc.emailTemplatesAPI.privatePreviewEmailTemplateAPI.queryOptions({
      input: { workspaceId, document, vars },
      enabled,
      placeholderData: (previous) => previous,
      staleTime: Number.POSITIVE_INFINITY,
      // A 429 must not be retried against the window that refused it.
      retry: false,
    }),
  )

/** Flows a document button can start (startExternalFlow). */
export const useFlowOptions = (workspaceId: string) =>
  useQuery(
    orpc.flowsAPI.privateListFlowsAPI.queryOptions({
      // The list-page cap (s205): one call never asks for more than 50 rows.
      input: { workspaceId, page: 1, perPage: 50 },
      select: (res) =>
        res.data.map((flow) => ({ value: String(flow.id), label: flow.name })),
    }),
  )
