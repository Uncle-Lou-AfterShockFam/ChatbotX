import { beforeEach, describe, expect, test, vi } from "vitest"
import { listRows, pagedServer } from "@/lib/query/testing/paged-server"

const mocks = vi.hoisted(() => ({
  privateListWorkspaceEmailTopicsAPI: vi.fn(),
}))

vi.mock("@/lib/orpc/orpc", () => ({
  client: {
    emailTopicsAPI: {
      privateListWorkspaceEmailTopicsAPI:
        mocks.privateListWorkspaceEmailTopicsAPI,
    },
  },
}))

const { createEmailTopicStore } = await import("../email-topic-store")

beforeEach(() => {
  mocks.privateListWorkspaceEmailTopicsAPI.mockReset()
})

describe("getAllEmailTopics", () => {
  test("pages past the server's 50-row cap: all 120 land (s205)", async () => {
    mocks.privateListWorkspaceEmailTopicsAPI.mockImplementation(
      pagedServer(listRows(1, 121)),
    )
    const store = createEmailTopicStore({ workspaceId: "workspace-1" })

    await store.getState().getAllEmailTopics()

    expect(store.getState().emailTopics).toHaveLength(120)
    expect(mocks.privateListWorkspaceEmailTopicsAPI).toHaveBeenCalledTimes(3)
    expect(mocks.privateListWorkspaceEmailTopicsAPI).toHaveBeenNthCalledWith(
      1,
      {
        workspaceId: "workspace-1",
        page: 1,
        perPage: 50,
        sort: [{ id: "id", desc: false }],
      },
    )
    expect(store.getState().loading).toBe(false)
  })

  test("is a no-op when workspaceId is empty", async () => {
    const store = createEmailTopicStore({ workspaceId: "" })

    await store.getState().getAllEmailTopics()

    expect(mocks.privateListWorkspaceEmailTopicsAPI).not.toHaveBeenCalled()
  })

  test("a failing page keeps the old list and records the error", async () => {
    mocks.privateListWorkspaceEmailTopicsAPI.mockRejectedValueOnce(
      new Error("boom"),
    )
    const store = createEmailTopicStore({
      workspaceId: "workspace-1",
      emailTopics: [{ id: "old" } as never],
    })

    await store.getState().getAllEmailTopics()

    expect(store.getState().emailTopics).toEqual([{ id: "old" }])
    expect(store.getState().error).toBeTruthy()
    expect(store.getState().loading).toBe(false)
  })
})
