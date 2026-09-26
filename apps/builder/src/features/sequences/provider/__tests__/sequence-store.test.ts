import { ORPCError } from "@orpc/client"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { listRows, pagedServer } from "@/lib/query/__tests__/paged-server"

const mocks = vi.hoisted(() => ({
  listSequencesWorkspaceAuthAPI: vi.fn(),
}))

vi.mock("@/lib/orpc/orpc", () => ({
  client: {
    sequencesAPI: {
      listSequencesWorkspaceAuthAPI: mocks.listSequencesWorkspaceAuthAPI,
    },
  },
}))

const { createSequenceStore } = await import("../sequence-store")

beforeEach(() => {
  mocks.listSequencesWorkspaceAuthAPI.mockReset()
})

describe("getAllActiveSequences", () => {
  test("fetches active sequences for the given workspaceId, page by page", async () => {
    mocks.listSequencesWorkspaceAuthAPI.mockResolvedValueOnce({
      data: [{ id: "1", name: "Welcome" }],
    })

    const store = createSequenceStore()

    await store.getState().getAllActiveSequences("workspace-1")

    expect(mocks.listSequencesWorkspaceAuthAPI).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      active: true,
      page: 1,
      perPage: 50,
      sort: [{ id: "id", desc: false }],
    })
    expect(store.getState().sequences).toEqual([{ id: "1", name: "Welcome" }])
  })

  test("pages past the server's 50-row cap: all 120 land (s205)", async () => {
    mocks.listSequencesWorkspaceAuthAPI.mockImplementation(
      pagedServer(listRows(1, 121)),
    )

    const store = createSequenceStore()
    await store.getState().getAllActiveSequences("workspace-1")

    expect(store.getState().sequences).toHaveLength(120)
    expect(store.getState().sequences.at(-1)).toMatchObject({ id: "120" })
    expect(mocks.listSequencesWorkspaceAuthAPI).toHaveBeenCalledTimes(3)
  })
})

describe("initialize", () => {
  test("fetches active sequences and marks the store initialized on success", async () => {
    mocks.listSequencesWorkspaceAuthAPI.mockResolvedValueOnce({
      data: [{ id: "1", name: "Welcome" }],
    })

    const store = createSequenceStore({ workspaceId: "workspace-1" })

    await store.getState().initialize()

    expect(mocks.listSequencesWorkspaceAuthAPI).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "workspace-1" }),
    )
    expect(store.getState().sequences).toEqual([{ id: "1", name: "Welcome" }])
    expect(store.getState().initialized).toBe(true)
    expect(store.getState().loading).toBe(false)
    expect(store.getState().error).toBeNull()
  })

  test("does not fetch again once already initialized", async () => {
    mocks.listSequencesWorkspaceAuthAPI.mockResolvedValue({ data: [] })

    const store = createSequenceStore({ workspaceId: "workspace-1" })

    await store.getState().initialize()
    await store.getState().initialize()

    expect(mocks.listSequencesWorkspaceAuthAPI).toHaveBeenCalledTimes(1)
  })

  test("sets error and leaves initialized false on a rejected request", async () => {
    mocks.listSequencesWorkspaceAuthAPI.mockRejectedValueOnce(
      new ORPCError("INTERNAL_SERVER_ERROR", { message: "HTTP 500" }),
    )

    const store = createSequenceStore({ workspaceId: "workspace-1" })

    await store.getState().initialize()

    expect(store.getState().error).toBe("HTTP 500")
    expect(store.getState().initialized).toBe(false)
    expect(store.getState().loading).toBe(false)
  })

  test("falls back to a generic message for a non-ORPCError rejection", async () => {
    mocks.listSequencesWorkspaceAuthAPI.mockRejectedValueOnce(
      new Error("network down"),
    )

    const store = createSequenceStore({ workspaceId: "workspace-1" })

    await store.getState().initialize()

    expect(store.getState().error).toBe("Failed to fetch sequences")
  })
})
