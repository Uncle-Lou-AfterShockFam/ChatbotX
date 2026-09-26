import { createStore } from "zustand/vanilla"
import { getClientErrorMessage } from "@/lib/orpc/client-error"
import { client } from "@/lib/orpc/orpc"
import { fetchAllListPages } from "@/lib/query/fetch-all-list-pages"
import type { ListSequencesResponse } from "../schema/action"

export type SequenceState = {
  loading: boolean
  error: string | null
  initialized: boolean

  workspaceId: string
  sequences: ListSequencesResponse["data"]
}

export type SequenceActions = {
  initialize: () => void
  getAllActiveSequences: (workspaceId: string) => void
}

export type SequenceStore = SequenceState & SequenceActions

export const createSequenceStore = (props: Partial<SequenceState> = {}) =>
  createStore<SequenceStore>((set, get) => ({
    loading: false,
    error: null,
    initialized: false,

    workspaceId: "",
    sequences: [],
    ...props,

    initialize: async () => {
      const { initialized, workspaceId } = get()

      if (initialized) {
        return
      }

      set({ loading: true, error: null })

      try {
        await get().getAllActiveSequences(workspaceId)
        set({
          loading: false,
          initialized: true,
        })
      } catch (error: unknown) {
        set({
          error: getClientErrorMessage(error, "Failed to fetch sequences"),
          loading: false,
        })
      }
    },

    getAllActiveSequences: async (workspaceId: string) => {
      const data = await fetchAllListPages((page) =>
        client.sequencesAPI.listSequencesWorkspaceAuthAPI({
          workspaceId,
          active: true,
          ...page,
        }),
      )

      set({ sequences: data })
    },
  }))
