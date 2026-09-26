import { beforeEach, describe, expect, test, vi } from "vitest"
import { listRows, pagedServer } from "@/lib/query/__tests__/paged-server"

const mocks = vi.hoisted(() => ({
  privateListFlowsAPI: vi.fn(),
}))

vi.mock("@/lib/orpc/orpc", () => ({
  client: {
    flowsAPI: { privateListFlowsAPI: mocks.privateListFlowsAPI },
  },
}))

const { createFlowStore } = await import("../flow-store")

beforeEach(() => {
  mocks.privateListFlowsAPI.mockReset()
})

describe("getAllActiveFlows", () => {
  test("pages past the server's 50-row cap: all 120 land (s205)", async () => {
    mocks.privateListFlowsAPI.mockImplementation(pagedServer(listRows(1, 121)))
    const store = createFlowStore({ workspaceId: "workspace-1" })

    await store.getState().getAllActiveFlows()

    expect(store.getState().flows).toHaveLength(120)
    expect(mocks.privateListFlowsAPI).toHaveBeenCalledTimes(3)
  })

  test("the filter rides every page and cannot override paging", async () => {
    mocks.privateListFlowsAPI.mockImplementation(pagedServer(listRows(1, 61)))
    const store = createFlowStore({ workspaceId: "workspace-1" })
    store.getState().appendFilter({ startType: "sendText" })

    await store.getState().getAllActiveFlows()

    expect(mocks.privateListFlowsAPI).toHaveBeenNthCalledWith(2, {
      workspaceId: "workspace-1",
      active: true,
      startType: "sendText",
      page: 2,
      perPage: 50,
      sort: [{ id: "id", desc: false }],
    })
  })

  test("is a no-op when workspaceId is empty", async () => {
    const store = createFlowStore({ workspaceId: "" })

    await store.getState().getAllActiveFlows()

    expect(mocks.privateListFlowsAPI).not.toHaveBeenCalled()
  })

  test("a failing page records the error and clears loading", async () => {
    mocks.privateListFlowsAPI.mockRejectedValueOnce(new Error("boom"))
    const store = createFlowStore({ workspaceId: "workspace-1" })

    await store.getState().getAllActiveFlows()

    expect(store.getState().error).toBeTruthy()
    expect(store.getState().loading).toBe(false)
  })
})
