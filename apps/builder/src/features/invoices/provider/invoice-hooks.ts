import type { InvoiceStatus } from "@chatbotx.io/database/partials"
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { useCallback, useMemo } from "react"
import { orpc } from "@/lib/orpc/query"

/** react-query hooks for hub invoices (s205b). */

export const useInvoices = (
  workspaceId: string,
  filter: { contactId?: string; status?: InvoiceStatus },
) =>
  useInfiniteQuery(
    orpc.invoicesAPI.privateListInvoicesAPI.infiniteOptions({
      input: (cursor: string | null) => ({
        workspaceId,
        contactId: filter.contactId,
        status: filter.status,
        cursor: cursor ?? undefined,
      }),
      initialPageParam: null,
      getNextPageParam: (last) => last.nextCursor,
    }),
  )

const useInvalidateInvoices = () => {
  const queryClient = useQueryClient()
  return useCallback(
    () => queryClient.invalidateQueries({ queryKey: orpc.invoicesAPI.key() }),
    [queryClient],
  )
}

/** Linked WooCommerce sites as select options (label = slug + currency). */
export const useWooCommerceSiteOptions = (
  workspaceId: string,
  enabled = true,
): { label: string; value: string }[] => {
  const { data } = useQuery(
    orpc.invoicesAPI.privateListWooCommerceSitesAPI.queryOptions({
      input: { workspaceId },
      enabled: Boolean(workspaceId) && enabled,
      select: (res) => res.data,
    }),
  )
  return useMemo(
    () =>
      (data ?? []).map((site) => ({
        label: `${site.siteSlug} (${site.currency})`,
        value: site.integrationId,
      })),
    [data],
  )
}

export const useCreateInvoice = () => {
  const invalidate = useInvalidateInvoices()
  return useMutation(
    orpc.invoicesAPI.privateCreateInvoiceAPI.mutationOptions({
      onSettled: () => invalidate(),
    }),
  )
}

export const useFinalizeInvoice = () => {
  const invalidate = useInvalidateInvoices()
  return useMutation(
    orpc.invoicesAPI.privateFinalizeInvoiceAPI.mutationOptions({
      onSettled: () => invalidate(),
    }),
  )
}

export const useVoidInvoice = () => {
  const invalidate = useInvalidateInvoices()
  return useMutation(
    orpc.invoicesAPI.privateVoidInvoiceAPI.mutationOptions({
      onSettled: () => invalidate(),
    }),
  )
}
