import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { client } from "@/lib/orpc/orpc"
import { orpc } from "@/lib/orpc/query"
import { fetchAllListPages } from "@/lib/query/fetch-all-list-pages"
import type { TimelineKind } from "../schema/resource"

/** react-query hooks for the Contact / Company 360 routes (s195). */

export const useCompanyMetrics = (workspaceId: string, companyId: string) =>
  useQuery(
    orpc.crmAPI.privateGetCompanyMetricsAPI.queryOptions({
      input: { workspaceId, id: companyId },
    }),
  )

export const useCompanyDeals = (workspaceId: string, companyId: string) =>
  useQuery(
    orpc.crmAPI.privateListCompanyDealsAPI.queryOptions({
      input: { workspaceId, id: companyId },
      select: (res) => res.data,
    }),
  )

export const useCompanyTasks = (workspaceId: string, companyId: string) =>
  useQuery(
    orpc.crmAPI.privateListCompanyTasksAPI.queryOptions({
      input: { workspaceId, id: companyId },
      select: (res) => res.data,
    }),
  )

export const useCompanyConversations = (
  workspaceId: string,
  companyId: string,
) =>
  useQuery(
    orpc.crmAPI.privateListCompanyConversationsAPI.queryOptions({
      input: { workspaceId, id: companyId },
      select: (res) => res.data,
    }),
  )

export const useCompanySubmissions = (workspaceId: string, companyId: string) =>
  useQuery(
    orpc.crmAPI.privateListCompanySubmissionsAPI.queryOptions({
      input: { workspaceId, id: companyId },
      select: (res) => res.data,
    }),
  )

export const useCompanyActivities = (workspaceId: string, companyId: string) =>
  useQuery(
    orpc.crmAPI.privateListCompanyActivitiesAPI.queryOptions({
      input: { workspaceId, id: companyId },
      select: (res) => res.data,
    }),
  )

export const useCompanyNotes = (workspaceId: string, companyId: string) =>
  useQuery(
    orpc.crmAPI.privateListCompanyNotesAPI.queryOptions({
      input: { workspaceId, id: companyId },
      select: (res) => res.data,
    }),
  )

/** Keyset-paged timelines: one infinite query per (target, kinds); a kinds change is a new key. */
export const useCompanyTimeline = (
  workspaceId: string,
  companyId: string,
  kinds: TimelineKind[],
) =>
  useInfiniteQuery(
    orpc.crmAPI.privateGetCompanyTimelineAPI.infiniteOptions({
      input: (cursor: string | null) => ({
        workspaceId,
        id: companyId,
        kinds: kinds.length > 0 ? kinds : undefined,
        cursor,
      }),
      initialPageParam: null,
      getNextPageParam: (last) => last.nextCursor,
    }),
  )

export const useContactTimeline = (
  workspaceId: string,
  contactId: string,
  kinds: TimelineKind[],
) =>
  useInfiniteQuery(
    orpc.crmAPI.privateGetContactTimelineAPI.infiniteOptions({
      input: (cursor: string | null) => ({
        workspaceId,
        contactId,
        kinds: kinds.length > 0 ? kinds : undefined,
        cursor,
      }),
      initialPageParam: null,
      getNextPageParam: (last) => last.nextCursor,
    }),
  )

export const useContactSubmissions = (workspaceId: string, contactId: string) =>
  useQuery(
    orpc.crmAPI.privateListContactSubmissionsAPI.queryOptions({
      input: { workspaceId, contactId },
      select: (res) => res.data,
    }),
  )

export const useContactTasks = (workspaceId: string, contactId: string) =>
  useQuery(
    orpc.crmAPI.privateListContactTasksAPI.queryOptions({
      input: { workspaceId, contactId },
      select: (res) => res.data,
    }),
  )

export const useContactConversation = (
  workspaceId: string,
  contactId: string,
) =>
  useQuery(
    orpc.crmAPI.privateGetContactConversationAPI.queryOptions({
      input: { workspaceId, contactId },
    }),
  )

export const useContactDeals = (workspaceId: string, contactId: string) =>
  useQuery({
    // Every deal, newest first, not one call the server caps at 50 (s205).
    queryKey: orpc.dealsAPI.privateListWorkspaceDealsAPI.key({
      type: "query",
      input: { workspaceId, contactId },
    }),
    queryFn: () =>
      fetchAllListPages(
        (page) =>
          client.dealsAPI.privateListWorkspaceDealsAPI({
            workspaceId,
            contactId,
            ...page,
          }),
        { desc: true },
      ),
  })

export const useContact = (workspaceId: string, contactId: string | null) =>
  useQuery(
    orpc.contactsAPIs.getContactAuthenticatedAPI.queryOptions({
      input: { workspaceId, contactId: contactId ?? "" },
      enabled: Boolean(contactId),
    }),
  )

/** Every pipeline with its stages: stage names for rows + the drawer's `pipeline` prop. */
export const usePipelines = (workspaceId: string) =>
  useQuery(
    orpc.pipelinesAPI.privateListWorkspacePipelinesAPI.queryOptions({
      input: { workspaceId },
      select: (res) => res.data,
    }),
  )

/** The DM conversation's messages, newest page first; `fetchNextPage` walks older. */
export const useMessages = (
  workspaceId: string,
  conversationId: string | null,
) =>
  useInfiniteQuery(
    orpc.messagesAPI.listMessagesAuthenticatedAPI.infiniteOptions({
      input: (cursor: string | undefined) => ({
        workspaceId,
        conversationId: conversationId ?? "",
        perPage: 30,
        cursor,
      }),
      initialPageParam: undefined,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
      enabled: Boolean(conversationId),
    }),
  )

/** After any 360-side write: the crm rollups, the deals and the contact itself refetch. */
export const useInvalidateCrm = () => {
  const queryClient = useQueryClient()
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.crmAPI.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.dealsAPI.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.dealTasksAPI.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.contactsAPIs.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.companiesAPI.key() }),
    ])
}
