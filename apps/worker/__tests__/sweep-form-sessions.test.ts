import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  expireDue: vi.fn(),
  emitAbandoned: vi.fn(async () => true),
  emitPendingAbandons: vi.fn(async () => 0),
  consumeChallenge: vi.fn(async () => true),
  add: vi.fn(async () => undefined),
  emitDueAbandons: vi.fn(async () => ({ claimed: 0, emitted: 0 })),
  pruneClosed: vi.fn(async () => 0),
}))

vi.mock("@chatbotx.io/business", () => ({
  conversationService: { consumeChallenge: mocks.consumeChallenge },
}))
vi.mock("@chatbotx.io/business/form", () => ({
  formSessionService: {
    expireDue: mocks.expireDue,
    emitAbandoned: mocks.emitAbandoned,
    emitPendingAbandons: mocks.emitPendingAbandons,
  },
  formVisitService: {
    emitDueAbandons: mocks.emitDueAbandons,
    pruneClosed: mocks.pruneClosed,
  },
}))
vi.mock("@chatbotx.io/events/context", async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks")
  const store = new AsyncLocalStorage<{ source?: string }>()
  return {
    runWithWebhookExecutionContext: (
      ctx: { source?: string },
      fn: () => unknown,
    ) => store.run(ctx, fn),
    isWebhookContext: () => store.getStore()?.source === "webhook",
  }
})
vi.mock("@chatbotx.io/redis", () => ({
  distributedLock: {
    runExclusive: ({ fn }: { fn: () => Promise<unknown> }) => fn(),
  },
}))
vi.mock("@chatbotx.io/worker-config", () => ({
  IntegrationJobAction: { sendFlow: "sendFlow" },
  integrationQueue: { add: mocks.add },
}))
vi.mock("../src/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { isWebhookContext } = (await import(
  "@chatbotx.io/events/context"
)) as unknown as { isWebhookContext: () => boolean }
const { sweepFormSessions } = await import(
  "../src/schedule/handlers/sweep-form-sessions"
)

const row = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  workspaceId: "ws-1",
  conversationId: "conv-1",
  contactInboxId: "ci-1",
  flowId: "flow-1",
  flowVersionId: null,
  nodeId: "node-1",
  stepId: "step-1",
  challengeId: `ch-${id}`,
  runStartedAt: new Date("2026-09-28T00:00:00Z"),
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.emitDueAbandons.mockResolvedValue({ claimed: 0, emitted: 0 })
})

describe("sweepFormSessions", () => {
  test("each expired run: compare-and-clear its challenge, then ONE deduped re-entry at the askForm step", async () => {
    mocks.expireDue.mockResolvedValueOnce([row("s1"), row("s2")])
    expect(await sweepFormSessions()).toEqual({
      expired: 2,
      abandonCatchUp: 0,
      webAbandoned: 0,
    })
    expect(mocks.consumeChallenge).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      conversationId: "conv-1",
      stepId: "step-1",
      challengeId: "ch-s1",
    })
    expect(mocks.add).toHaveBeenCalledWith(
      "sendFlow",
      expect.objectContaining({
        data: expect.objectContaining({
          nodeId: "node-1",
          startFromStepId: "step-1",
          contactInboxId: "ci-1",
          flowVersionId: undefined,
          runStartedAt: "2026-09-28T00:00:00.000Z",
          metadata: {
            type: "askFormExpired",
            stepId: "step-1",
            formSessionId: "s1",
          },
        }),
      }),
      { jobId: "form-session-expired-s1" },
    )
  })

  test("a full batch pulls the next one; a short batch stops", async () => {
    mocks.expireDue
      .mockResolvedValueOnce(
        Array.from({ length: 100 }, (_, i) => row(`a${i}`)),
      )
      .mockResolvedValueOnce([row("b1")])
    expect(await sweepFormSessions()).toEqual({
      expired: 101,
      abandonCatchUp: 0,
      webAbandoned: 0,
    })
    expect(mocks.expireDue).toHaveBeenCalledTimes(2)
  })

  test("a failed re-entry is logged and the sweep continues", async () => {
    mocks.expireDue.mockResolvedValueOnce([row("s1"), row("s2")])
    mocks.add.mockRejectedValueOnce(new Error("redis down"))
    expect(await sweepFormSessions()).toEqual({
      expired: 2,
      abandonCatchUp: 0,
      webAbandoned: 0,
    })
    expect(mocks.add).toHaveBeenCalledTimes(2)
  })

  test("nothing due: no challenge touched, no job", async () => {
    mocks.expireDue.mockResolvedValueOnce([])
    expect(await sweepFormSessions()).toEqual({
      expired: 0,
      abandonCatchUp: 0,
      webAbandoned: 0,
    })
    expect(mocks.add).not.toHaveBeenCalled()
  })

  test("each expired run claims formAbandoned once; then ONE catch-up pass (s220 A2-3)", async () => {
    mocks.expireDue.mockResolvedValueOnce([row("s1"), row("s2")])
    mocks.emitPendingAbandons.mockResolvedValueOnce(3)
    expect(await sweepFormSessions()).toEqual({
      expired: 2,
      abandonCatchUp: 3,
      webAbandoned: 0,
    })
    expect(mocks.emitAbandoned).toHaveBeenCalledTimes(2)
    expect(mocks.emitAbandoned).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s1" }),
    )
    expect(mocks.emitPendingAbandons).toHaveBeenCalledTimes(1)
    expect(mocks.emitPendingAbandons).toHaveBeenCalledWith({ limit: 100 })
  })

  test("a failed claim or catch-up is logged; routing still happened", async () => {
    mocks.expireDue.mockResolvedValueOnce([row("s1"), row("s2")])
    mocks.emitAbandoned.mockRejectedValueOnce(new Error("pg down"))
    mocks.emitPendingAbandons.mockRejectedValueOnce(new Error("pg down"))
    expect(await sweepFormSessions()).toEqual({
      expired: 2,
      abandonCatchUp: 0,
      webAbandoned: 0,
    })
    expect(mocks.add).toHaveBeenCalledTimes(2)
    expect(mocks.emitAbandoned).toHaveBeenCalledTimes(2)
  })

  test("nothing expired still runs the catch-up (a crash between end and claim)", async () => {
    mocks.expireDue.mockResolvedValueOnce([])
    mocks.emitPendingAbandons.mockResolvedValueOnce(1)
    expect(await sweepFormSessions()).toEqual({
      expired: 0,
      abandonCatchUp: 1,
      webAbandoned: 0,
    })
    expect(mocks.emitAbandoned).not.toHaveBeenCalled()
  })

  test("abandon emits run in the channel (webhook) context; routing does not", async () => {
    const seen: boolean[] = []
    mocks.expireDue.mockResolvedValueOnce([row("s1")])
    mocks.emitAbandoned.mockImplementationOnce(() => {
      seen.push(isWebhookContext())
      return Promise.resolve(true)
    })
    mocks.emitPendingAbandons.mockImplementationOnce(() => {
      seen.push(isWebhookContext())
      return Promise.resolve(0)
    })
    mocks.add.mockImplementationOnce(() => {
      seen.push(isWebhookContext())
      return Promise.resolve(undefined)
    })
    await sweepFormSessions()
    // add (routing) first, then the claim, then the catch-up
    expect(seen).toEqual([false, true, true])
  })

  test("the web pass (s224a): batches of 100 in the webhook context until short, then one prune", async () => {
    mocks.expireDue.mockResolvedValue([])
    const contexts: boolean[] = []
    mocks.emitDueAbandons
      .mockImplementationOnce(() => {
        contexts.push(isWebhookContext())
        return Promise.resolve({ claimed: 100, emitted: 99 })
      })
      .mockImplementationOnce(() => {
        contexts.push(isWebhookContext())
        return Promise.resolve({ claimed: 3, emitted: 3 })
      })
    expect(await sweepFormSessions()).toEqual({
      expired: 0,
      abandonCatchUp: 0,
      webAbandoned: 102,
    })
    expect(mocks.emitDueAbandons).toHaveBeenCalledTimes(2)
    expect(mocks.emitDueAbandons).toHaveBeenCalledWith({ limit: 100 })
    expect(contexts).toEqual([true, true])
    expect(mocks.pruneClosed).toHaveBeenCalledTimes(1)
  })

  test("a failing web pass is logged; the chat half's result stands", async () => {
    mocks.expireDue.mockResolvedValueOnce([row("s1")])
    mocks.emitDueAbandons.mockRejectedValueOnce(new Error("db down"))
    expect(await sweepFormSessions()).toEqual({
      expired: 1,
      abandonCatchUp: 0,
      webAbandoned: 0,
    })
    expect(mocks.add).toHaveBeenCalledTimes(1)
    // The prune runs on its own (Codex probe s224a).
    expect(mocks.pruneClosed).toHaveBeenCalledTimes(1)
  })

  test("a failing prune is logged and the sweep result stands", async () => {
    mocks.expireDue.mockResolvedValueOnce([])
    mocks.pruneClosed.mockRejectedValueOnce(new Error("db down"))
    expect(await sweepFormSessions()).toEqual({
      expired: 0,
      abandonCatchUp: 0,
      webAbandoned: 0,
    })
  })
})
