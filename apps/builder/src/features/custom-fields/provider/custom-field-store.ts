import { createStore } from "zustand/vanilla"
import type { BotFieldResource } from "@/features/bot-fields/schema/resource"
import { getClientErrorMessage } from "@/lib/orpc/client-error"
import { client } from "@/lib/orpc/orpc"
import { fetchAllPages } from "@/lib/query/fetch-all-pages"
import type { CustomFieldResource } from "../schema/resource"

/**
 * The list endpoints cap a page at 50 (`maxLimit` in
 * `@chatbotx.io/database/utils`), so a single `perPage: maxPerPage` call
 * silently returned the first 50 fields only: a workspace with more never saw
 * the rest in any picker or contact panel (s201). Page through all of them,
 * ordered by id so offset pages are stable.
 */
const FIELD_PAGE_SIZE = 50
const FIELD_MAX_PAGES = 40

export const fetchAllFieldPages = async <T extends { id: string }>(
  fetchPage: (input: {
    page: number
    perPage: number
    sort: { id: string; desc: boolean }[]
  }) => Promise<{ data: T[] }>,
): Promise<T[]> => {
  const rows = await fetchAllPages<number, T>({
    initialPageParam: 1,
    maxPages: FIELD_MAX_PAGES,
    fetchPage: async (page) => {
      const { data } = await fetchPage({
        page,
        perPage: FIELD_PAGE_SIZE,
        sort: [{ id: "id", desc: false }],
      })
      return {
        items: data,
        nextPageParam: data.length < FIELD_PAGE_SIZE ? undefined : page + 1,
      }
    },
  })
  return [...new Map(rows.map((row) => [row.id, row])).values()]
}

export type CustomFieldState = {
  loading: boolean
  error: string | null
  initialized: boolean

  workspaceId: string
  customFields: CustomFieldResource[]

  botFields: BotFieldResource[]
  botFieldsLoading: boolean
  botFieldsError: string | null
  botFieldsInitialized: boolean
}

export type CustomFieldActions = {
  initialize: () => Promise<void>
  getAllCustomFields: () => Promise<void>
  /**
   * Lazy, deduped fetch of Account Fields (bot fields). Unlike `initialize`,
   * this is NEVER called from `initialize()` itself: `CustomFieldStoreProvider`
   * mounts on ~20 pages (including inbox), so fetching bot fields eagerly on
   * every page view would add a wasted request at chatbot scale. Callers that
   * actually need bot fields (e.g. the combined field picker) invoke this
   * explicitly.
   */
  ensureBotFieldsLoaded: () => Promise<void>
}

export type CustomFieldStore = CustomFieldState & CustomFieldActions

export const createCustomFieldStore = (props: Partial<CustomFieldState>) =>
  createStore<CustomFieldStore>((set, get) => ({
    loading: false,
    error: null,
    initialized: false,

    workspaceId: "",
    customFields: [],

    botFields: [],
    botFieldsLoading: false,
    botFieldsError: null,
    botFieldsInitialized: false,
    ...props,

    initialize: async () => {
      const { initialized } = get()

      if (initialized) {
        return
      }

      try {
        await get().getAllCustomFields()
      } catch (error: unknown) {
        set({
          error: getClientErrorMessage(error, "Failed to fetch custom fields"),
        })
      } finally {
        set({ initialized: true })
      }
    },

    getAllCustomFields: async () => {
      const { workspaceId, loading } = get()

      // Skip if already initialized for the same workspaceId or currently loading
      if (loading || !workspaceId) {
        return
      }

      set({ loading: true, error: null })

      try {
        const data = await fetchAllFieldPages((page) =>
          client.customFieldsAPI.privateListCustomFieldsAPI({
            workspaceId,
            ...page,
          }),
        )
        set({ customFields: data })
      } catch (error: unknown) {
        set({
          error: getClientErrorMessage(error, "Failed to fetch custom fields"),
        })
      } finally {
        set({ loading: false })
      }
    },

    ensureBotFieldsLoaded: async () => {
      const { workspaceId, botFieldsInitialized, botFieldsLoading } = get()

      // Dedupe: already loaded, or a fetch already in flight (multiple
      // pickers mounted on the same page must trigger only one request).
      if (botFieldsInitialized || botFieldsLoading || !workspaceId) {
        return
      }

      set({ botFieldsLoading: true, botFieldsError: null })

      try {
        const data = await fetchAllFieldPages((page) =>
          client.botFieldAPIs.privateListBotFieldsAPI({ workspaceId, ...page }),
        )
        set({ botFields: data, botFieldsInitialized: true })
      } catch (error: unknown) {
        // Leave `botFieldsInitialized` false on failure — unlike a poisoned
        // "loaded" state, this lets a later picker mount retry the fetch
        // instead of getting stuck with an empty list forever.
        set({
          botFieldsError: getClientErrorMessage(
            error,
            "Failed to fetch bot fields",
          ),
        })
      } finally {
        set({ botFieldsLoading: false })
      }
    },
  }))
