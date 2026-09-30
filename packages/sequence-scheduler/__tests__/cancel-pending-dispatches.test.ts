import { beforeEach, describe, expect, test, vi } from "vitest"

const findManySpy =
  vi.fn<(args: { where: Record<string, unknown> }) => Promise<unknown[]>>()
const updateWhereSpy = vi.fn<(arg: unknown) => Promise<unknown>>()
const removeFromScheduleSpy = vi.fn()

vi.mock("@chatbotx.io/database/client", () => ({
  db: {},
  and: (...args: unknown[]) => ({ __and: args }),
  eq: (c: unknown, v: unknown) => ({ __eq: [c, v] }),
  inArray: (c: unknown, v: unknown) => ({ __inArray: [c, v] }),
}))
vi.mock("@chatbotx.io/database/schema", () => ({
  sequenceDispatchModel: {
    id: { __column: "id" },
    workspaceId: { __column: "workspaceId" },
    status: { __column: "status" },
  },
}))
vi.mock("@chatbotx.io/redis", () => ({
  sequenceConnections: { useExisting: () => Promise.resolve({}) },
}))
vi.mock("@chatbotx.io/scheduler", () => ({
  SchedulerClient: class {
    removeFromSchedule = removeFromScheduleSpy
  },
}))

beforeEach(() => {
  findManySpy.mockReset()
  updateWhereSpy.mockReset().mockResolvedValue(undefined)
  removeFromScheduleSpy.mockReset()
})

describe("dispatch cancellation (workspace) and schedule removal", () => {
  test("removeDispatchesFromSchedule removes each dispatch from Redis", async () => {
    const { removeDispatchesFromSchedule } = await import(
      "../src/dispatch-cancel"
    )

    await removeDispatchesFromSchedule([
      { id: "d1", bucket: 1 },
      { id: "d2", bucket: 2 },
    ])

    expect(removeFromScheduleSpy).toHaveBeenCalledTimes(2)
    expect(removeFromScheduleSpy).toHaveBeenCalledWith(1, "d1")
    expect(removeFromScheduleSpy).toHaveBeenCalledWith(2, "d2")
  })

  test("removeDispatchesFromSchedule attempts every Redis removal before reporting failures", async () => {
    removeFromScheduleSpy
      .mockRejectedValueOnce(new Error("redis down"))
      .mockResolvedValueOnce(undefined)
    const { removeDispatchesFromSchedule } = await import(
      "../src/dispatch-cancel"
    )

    await expect(
      removeDispatchesFromSchedule([
        { id: "d1", bucket: 1 },
        { id: "d2", bucket: 2 },
      ]),
    ).rejects.toThrow("Failed to remove sequence dispatches from schedule")

    expect(removeFromScheduleSpy).toHaveBeenCalledTimes(2)
    expect(removeFromScheduleSpy).toHaveBeenCalledWith(1, "d1")
    expect(removeFromScheduleSpy).toHaveBeenCalledWith(2, "d2")
  })

  test("removeDispatchesFromSchedule identifies failed dispatches", async () => {
    removeFromScheduleSpy
      .mockRejectedValueOnce(new Error("redis down"))
      .mockResolvedValueOnce(undefined)
    const { removeDispatchesFromSchedule } = await import(
      "../src/dispatch-cancel"
    )

    await expect(
      removeDispatchesFromSchedule([
        { id: "d1", bucket: 1 },
        { id: "d2", bucket: 2 },
      ]),
    ).rejects.toThrow("d1 bucket=1")
  })
})
