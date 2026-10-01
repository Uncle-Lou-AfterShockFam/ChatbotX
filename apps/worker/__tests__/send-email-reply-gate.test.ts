// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from "vitest"

const findReplyGate = vi.fn()
vi.mock("@chatbotx.io/business/contact-sequence", () => ({
  contactSequenceService: {
    findReplyGate: (...args: unknown[]) => findReplyGate(...args),
  },
}))

const { lineReplyGateOf, nextWholeMinute, replyGateSince } = await import(
  "../src/integration/handlers/send-email-reply-gate"
)

const at = (iso: string) => new Date(iso)
const seqMeta = {
  type: "sequenceSchedule",
  sequenceId: "555",
  sequenceStepId: "1",
  dispatchId: "9001",
  contactInboxId: "ci-1",
} as never

describe("s236 nextWholeMinute: strictly after, on the minute", () => {
  test("rounds up inside a minute and steps over an exact minute", () => {
    expect(nextWholeMinute(at("2026-10-01T12:00:30.500Z")).toISOString()).toBe(
      "2026-10-01T12:01:00.000Z",
    )
    expect(nextWholeMinute(at("2026-10-01T12:00:00.000Z")).toISOString()).toBe(
      "2026-10-01T12:01:00.000Z",
    )
    expect(nextWholeMinute(at("2026-10-01T12:00:59.999Z")).toISOString()).toBe(
      "2026-10-01T12:01:00.000Z",
    )
  })
})

describe("s236 replyGateSince: T = nextWholeMinute(max(enrolledAt, repliedAt)), repliedAt only while not ended", () => {
  test("first cycle (no answer yet): the minute after enrolment, so the reply that triggered a keyword enrolment in the same minute never trips it", () => {
    expect(
      replyGateSince({
        status: "active",
        enrolledAt: at("2026-10-01T12:00:20Z"),
        repliedAt: null,
      }).toISOString(),
    ).toBe("2026-10-01T12:01:00.000Z")
  })

  test("after a reply end + operator reactivation (repliedAt > enrolledAt): past the overridden reply, never re-tripped by it", () => {
    expect(
      replyGateSince({
        status: "active",
        enrolledAt: at("2026-10-01T12:00:20Z"),
        repliedAt: at("2026-10-01T15:42:10Z"),
      }).toISOString(),
    ).toBe("2026-10-01T15:43:00.000Z")
  })

  test("after a restart of a finished contact (enrolledAt reset past the old reply): the new cycle start", () => {
    expect(
      replyGateSince({
        status: "active",
        enrolledAt: at("2026-10-02T09:00:05Z"),
        repliedAt: at("2026-10-01T15:42:10Z"),
      }).toISOString(),
    ).toBe("2026-10-02T09:01:00.000Z")
  })

  test("an ENDED enrolment keeps the cycle start: the reply that ended it must stop the mail", () => {
    expect(
      replyGateSince({
        status: "ended",
        enrolledAt: at("2026-10-01T12:00:20Z"),
        repliedAt: at("2026-10-01T15:42:10Z"),
      }).toISOString(),
    ).toBe("2026-10-01T12:01:00.000Z")
  })

  test("a held / paused enrolment still moves past its recorded answer", () => {
    for (const status of ["held", null]) {
      expect(
        replyGateSince({
          status,
          enrolledAt: at("2026-10-01T12:00:20Z"),
          repliedAt: at("2026-10-01T13:00:00Z"),
        }).toISOString(),
      ).toBe("2026-10-01T13:01:00.000Z")
    }
  })
})

describe("s236 lineReplyGateOf: only a stop-on-reply sequence send carries the gate", () => {
  beforeEach(() => {
    findReplyGate.mockReset()
  })

  test("stopOnReply true: the ISO instant, looked up by the dispatch in this workspace", async () => {
    findReplyGate.mockResolvedValue({
      stopOnReply: true,
      status: "active",
      enrolledAt: at("2026-10-01T12:00:20Z"),
      repliedAt: null,
    })
    await expect(
      lineReplyGateOf({ workspaceId: "11", metadata: seqMeta }),
    ).resolves.toBe("2026-10-01T12:01:00.000Z")
    expect(findReplyGate).toHaveBeenCalledWith({
      dispatchId: "9001",
      workspaceId: "11",
    })
  })

  test("stopOnReply false, or the dispatch / enrolment gone: no gate", async () => {
    findReplyGate.mockResolvedValueOnce({
      stopOnReply: false,
      status: "active",
      enrolledAt: at("2026-10-01T12:00:20Z"),
      repliedAt: null,
    })
    await expect(
      lineReplyGateOf({ workspaceId: "11", metadata: seqMeta }),
    ).resolves.toBeUndefined()
    findReplyGate.mockResolvedValueOnce(null)
    await expect(
      lineReplyGateOf({ workspaceId: "11", metadata: seqMeta }),
    ).resolves.toBeUndefined()
  })

  test("not a sequence send (none, broadcast, flow node, junk) or no usable dispatch id: no gate, no lookup", async () => {
    const metas = [
      undefined,
      null,
      {},
      { type: "broadcast", broadcastId: "1", contactInboxId: "ci" },
      { type: "flowNode" },
      { ...(seqMeta as object), dispatchId: "" },
      { ...(seqMeta as object), dispatchId: "d" },
      { ...(seqMeta as object), dispatchId: 9001 },
      { ...(seqMeta as object), dispatchId: "1".repeat(20) },
    ]
    for (const metadata of metas) {
      await expect(
        lineReplyGateOf({ workspaceId: "11", metadata: metadata as never }),
      ).resolves.toBeUndefined()
    }
    expect(findReplyGate).not.toHaveBeenCalled()
  })

  test("a read error propagates (the job retries before anything is written)", async () => {
    findReplyGate.mockRejectedValueOnce(new Error("db down"))
    await expect(
      lineReplyGateOf({ workspaceId: "11", metadata: seqMeta }),
    ).rejects.toThrow("db down")
  })

  test("fuzz: T is always a whole minute, strictly after the floor, never before enrolment", () => {
    for (let i = 0; i < 500; i++) {
      const enrolledAt = new Date(
        1_790_000_000_000 + Math.floor(Math.random() * 1e10),
      )
      const repliedAt =
        Math.random() < 0.3
          ? null
          : new Date(
              enrolledAt.getTime() + Math.floor((Math.random() - 0.3) * 1e9),
            )
      const status = Math.random() < 0.2 ? "ended" : "active"
      const t = replyGateSince({ status, enrolledAt, repliedAt }).getTime()
      expect(t % 60_000).toBe(0)
      expect(t).toBeGreaterThan(enrolledAt.getTime())
      if (status !== "ended" && repliedAt) {
        expect(t).toBeGreaterThan(repliedAt.getTime())
      }
      expect(
        t -
          Math.max(
            enrolledAt.getTime(),
            status === "ended" ? 0 : (repliedAt?.getTime() ?? 0),
          ),
      ).toBeLessThanOrEqual(60_000)
    }
  })
})
