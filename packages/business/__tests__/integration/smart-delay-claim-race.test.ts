// @vitest-environment node

/**
 * The smart-delay claim CASes against a REAL Postgres, under real concurrency.
 *
 * Every other smart-delay test mocks the database, so none of them can show
 * the property the resume paths actually rely on: when two connections race
 * an `UPDATE ... WHERE status IN (...)` on one row, READ COMMITTED re-checks
 * the WHERE against the winner's committed version and the loser matches
 * nothing. That is what makes exactly one of event / timeout / retry own a
 * row, and what makes a stale generation unable to finish, heartbeat or
 * requeue a row someone else has since claimed.
 *
 * Rows are seeded in a transaction with
 * `SET LOCAL session_replication_role = replica` (skips the Workspace / Conversation
 * FKs; no claim query joins them) and deleted afterwards.
 *
 * The suite SKIPS itself unless `DATABASE_URL` points at a reachable database
 * (`setup-env` defines a non-routable `127.0.0.1:1` sentinel). Run it against
 * a migrated scratch Postgres with (test:db refuses to run without one):
 *
 *     DATABASE_URL=postgres://... pnpm --filter @chatbotx.io/business test:db
 */

import { type DatabaseClient, db, sql } from "@chatbotx.io/database/client"
import { afterAll, afterEach, describe, expect, test, vi } from "vitest"
import { MAX_RESUME_CLAIMS, smartDelayService } from "../../src/smart-delay"
import { runSmartDelayCancelLoop } from "../../src/smart-delay/cancel-loop"

// The cancel loop drops each canceled row's delayed BullMQ job; no Redis here.
vi.mock("@chatbotx.io/worker-config", () => ({
  integrationQueue: { remove: vi.fn().mockResolvedValue(undefined) },
}))

/** The `setup-env` sentinel: a real database never listens on port 1. */
const NON_ROUTABLE_PORT = "1"

function realDatabaseUrl(): string | null {
  const url = process.env.DATABASE_URL
  if (!url) {
    return null
  }
  try {
    return new URL(url).port === NON_ROUTABLE_PORT ? null : url
  } catch {
    return null
  }
}

const databaseUrl = realDatabaseUrl()

// `test:db` sets this: there, a skip would be a silent green with nothing run.
if (process.env.REQUIRE_REAL_DB === "1" && !databaseUrl) {
  throw new Error(
    "test:db needs DATABASE_URL pointing at a migrated Postgres (it is unset or the setup-env sentinel)",
  )
}

/** Ids far above any snowflake a scratch database would hold. */
const ID_BASE = 9_100_000_000_000_000n
const RACE_ITERATIONS = 200

let nextId = ID_BASE
const seeded: string[] = []
const seededInboxes: string[] = []

function mintId(): string {
  nextId += 1n
  return nextId.toString()
}

type RowState = {
  status: string
  claimGeneration: number
  nodeId: string | null
}

async function insertRow(props: {
  status: "pending" | "scheduled" | "running"
  claimGeneration?: number
  workspaceId?: string
  contactInboxId?: string
}): Promise<string> {
  const id = mintId()
  const generation = props.claimGeneration ?? 0
  const workspaceId = props.workspaceId ?? "1"
  const contactInboxId = props.contactInboxId ?? "1"
  await db.transaction(async (tx) => {
    // Transaction-scoped: the pooled connection goes back with FKs enforced.
    await tx.execute(sql`SET LOCAL session_replication_role = replica`)
    await tx.execute(sql`
      INSERT INTO "ContactOnSmartDelay"
        (id, "workspaceId", "flowId", "contactInboxId", "conversationId",
         "nodeId", "eventNodeId", type, "triggerAt", status,
         "claimGeneration", "claimedAt")
      VALUES (${id}, ${workspaceId}, 1, ${contactInboxId}, 1, 'timeout-edge',
              'event-edge', 'waitForEvent', clock_timestamp() + interval '1 hour', ${props.status}::"ContactOnSmartDelayStatus",
              ${generation},
              ${props.status === "running" ? sql`now()` : sql`NULL`})`)
  })
  seeded.push(id)
  return id
}

async function readRow(id: string): Promise<RowState> {
  const result = await db.execute<RowState>(sql`
    SELECT status, "claimGeneration", "nodeId"
      FROM "ContactOnSmartDelay" WHERE id = ${id}`)
  const row = result.rows[0]
  if (!row) {
    throw new Error(`row ${id} vanished`)
  }
  return row
}

async function setStatus(id: string, status: "scheduled"): Promise<void> {
  await db.execute(sql`
    UPDATE "ContactOnSmartDelay"
       SET status = ${status}::"ContactOnSmartDelayStatus" WHERE id = ${id}`)
}

// Hooks at file level: both suites share the seeded rows and the one pool.
afterEach(async () => {
  if (!databaseUrl) {
    return
  }
  if (seeded.length > 0) {
    const ids = seeded.splice(0)
    await db.execute(sql`
      DELETE FROM "ContactOnSmartDelay"
       WHERE id IN (${sql.join(
         ids.map((id) => sql`${id}`),
         sql`, `,
       )})`)
  }
  if (seededInboxes.length > 0) {
    const ids = seededInboxes.splice(0)
    await db.execute(sql`
      DELETE FROM "ContactInbox"
       WHERE id IN (${sql.join(
         ids.map((id) => sql`${id}`),
         sql`, `,
       )})`)
  }
})

afterAll(async () => {
  if (!databaseUrl) {
    return
  }
  await db.$client.end()
})

describe.skipIf(!databaseUrl)("smart delay claim CAS on real Postgres", () => {
  test(`event x2 vs timeout racing one row: exactly one claim wins (${RACE_ITERATIONS} rounds)`, async () => {
    let eventWins = 0
    let timeoutWins = 0
    for (let round = 0; round < RACE_ITERATIONS; round++) {
      const id = await insertRow({ status: "scheduled" })
      const results = await Promise.all([
        smartDelayService.claimForEvent({ id }),
        smartDelayService.claimRunning({ id }),
        smartDelayService.claimForEvent({ id }),
      ])
      const winners = results.filter((row) => row !== null)
      expect(winners, `round ${round}`).toHaveLength(1)
      expect(winners[0]?.claimGeneration).toBe(1)

      const row = await readRow(id)
      expect(row.status).toBe("running")
      expect(row.claimGeneration).toBe(1)
      if (results[1] === null) {
        eventWins += 1
        expect(row.nodeId).toBe("event-edge")
      } else {
        timeoutWins += 1
        expect(row.nodeId).toBe("timeout-edge")
      }
    }
    expect(eventWins + timeoutWins).toBe(RACE_ITERATIONS)
    // Which side wins is scheduling; the split is printed as race evidence.
    console.info(
      `claim race: event won ${eventWins}, timeout won ${timeoutWins}`,
    )
  })

  test("a claim blocked on the winner's row lock re-checks and loses after commit", async () => {
    const id = await insertRow({ status: "scheduled" })
    let releaseWinner: () => void = () => undefined
    const winnerHolds = new Promise<void>((resolve) => {
      releaseWinner = resolve
    })
    let winnerClaimed: () => void = () => undefined
    const winnerHasLock = new Promise<void>((resolve) => {
      winnerClaimed = resolve
    })

    const winner = db.transaction(async (tx) => {
      const row = await smartDelayService.claimForEvent({ tx, id })
      winnerClaimed()
      await winnerHolds
      return row
    })
    await winnerHasLock

    let loserSettled = false
    const loser = smartDelayService.claimRunning({ id }).finally(() => {
      loserSettled = true
    })
    // The loser is parked on the row lock, not failed fast.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(loserSettled).toBe(false)

    releaseWinner()
    expect(await winner).not.toBeNull()
    expect(await loser).toBeNull()
    expect(await readRow(id)).toMatchObject({
      status: "running",
      claimGeneration: 1,
      nodeId: "event-edge",
    })
  })

  test("sweep vs finish racing one running row: exactly one lands", async () => {
    for (let round = 0; round < 50; round++) {
      const id = await insertRow({ status: "running", claimGeneration: 1 })
      const [swept, finished] = await Promise.all([
        smartDelayService.resetStuckRunning({
          ids: [id],
          claimedAtBefore: new Date(Date.now() + 60_000),
        }),
        smartDelayService.finishClaimedRun({ id, generation: 1 }),
      ])
      expect(swept + (finished ? 1 : 0), `round ${round}`).toBe(1)
      expect((await readRow(id)).status).toBe(
        finished ? "completed" : "pending",
      )
    }
  })

  test("a stale generation cannot heartbeat, finish or requeue a re-claimed row", async () => {
    const id = await insertRow({ status: "scheduled" })
    const first = await smartDelayService.claimRunning({ id })
    expect(first?.claimGeneration).toBe(1)

    // Worker 1 stalls; the sweep resets it, the scanner re-schedules it.
    expect(
      await smartDelayService.resetStuckRunning({
        ids: [id],
        claimedAtBefore: new Date(Date.now() + 60_000),
      }),
    ).toBe(1)
    await setStatus(id, "scheduled")
    const second = await smartDelayService.claimRunning({ id })
    expect(second?.claimGeneration).toBe(2)

    const stale = await Promise.all([
      smartDelayService.heartbeatClaim({ id, generation: 1 }),
      smartDelayService.finishClaimedRun({ id, generation: 1 }),
      smartDelayService.requeueClaimedRun({ id, generation: 1 }),
    ])
    expect(stale).toEqual([false, false, null])
    expect(await readRow(id)).toMatchObject({
      status: "running",
      claimGeneration: 2,
    })

    expect(await smartDelayService.heartbeatClaim({ id, generation: 2 })).toBe(
      true,
    )
    expect(
      await smartDelayService.finishClaimedRun({ id, generation: 2 }),
    ).toBe(true)
    expect((await readRow(id)).status).toBe("completed")
  })

  test("requeue on the last allowed claim fails the row instead", async () => {
    const id = await insertRow({
      status: "running",
      claimGeneration: MAX_RESUME_CLAIMS,
    })
    expect(
      await smartDelayService.requeueClaimedRun({
        id,
        generation: MAX_RESUME_CLAIMS,
      }),
    ).toBe("failed")
    expect((await readRow(id)).status).toBe("failed")

    const below = await insertRow({
      status: "running",
      claimGeneration: MAX_RESUME_CLAIMS - 1,
    })
    expect(
      await smartDelayService.requeueClaimedRun({
        id: below,
        generation: MAX_RESUME_CLAIMS - 1,
      }),
    ).toBe("scheduled")
  })
})

async function insertContactInbox(contactId: string): Promise<string> {
  const id = mintId()
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`)
    await tx.execute(sql`
      INSERT INTO "ContactInbox"
        (id, "originalContactId", "contactId", "inboxId", channel, source, "sourceId")
      VALUES (${id}, ${contactId}, ${contactId}, 1, 'api', 'api', ${`s202-${id}`})`)
  })
  seededInboxes.push(id)
  return id
}

async function statusesOf(ids: string[]): Promise<string[]> {
  return await Promise.all(ids.map(async (id) => (await readRow(id)).status))
}

/**
 * Holds the row lock of one running row inside an open transaction (the
 * window a heartbeat / claim UPDATE holds it for), until `release()`; the
 * holder then runs `then` in the same transaction before committing.
 */
async function holdRowLock(
  id: string,
  then: (tx: DatabaseClient) => Promise<void> = async () => undefined,
) {
  let release: () => void = () => undefined
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  let locked: () => void = () => undefined
  const hasLock = new Promise<void>((resolve) => {
    locked = resolve
  })
  const done = db.transaction(async (tx) => {
    // A second UPDATE of a row this tx already updated re-runs the FK checks;
    // the seeded workspace does not exist.
    await tx.execute(sql`SET LOCAL session_replication_role = replica`)
    expect(
      await smartDelayService.heartbeatClaim({ tx, id, generation: 1 }),
    ).toBe(true)
    locked()
    await released
    await then(tx)
  })
  await hasLock
  return { release, done }
}

function cancelWorkspace(workspaceId: string, batchSize: number) {
  return runSmartDelayCancelLoop({
    workspaceId,
    batchSize,
    maxBatches: 50,
    logLabel: "s202-test",
    fetchBatch: (limit) =>
      smartDelayService.cancelActiveForWorkspace({ workspaceId, limit }),
  })
}

describe.skipIf(!databaseUrl)("smart delay cancel vs a held row lock", () => {
  test("workspace cancel waits for a heartbeat's lock instead of skipping the row", async () => {
    const workspaceId = mintId()
    const locked = await insertRow({
      status: "running",
      claimGeneration: 1,
      workspaceId,
    })
    const others = [
      await insertRow({ status: "running", claimGeneration: 1, workspaceId }),
      await insertRow({ status: "pending", workspaceId }),
      await insertRow({ status: "scheduled", workspaceId }),
    ]
    const holder = await holdRowLock(locked)

    let settled = false
    const cancel = cancelWorkspace(workspaceId, 10).finally(() => {
      settled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
    // Parked on the heartbeat's row lock, not done with the row skipped.
    const settledWhileLocked = settled
    holder.release()
    await holder.done
    expect(settledWhileLocked).toBe(false)
    expect(await cancel).toBe(4)
    expect(await statusesOf([locked, ...others])).toEqual([
      "canceled",
      "canceled",
      "canceled",
      "canceled",
    ])
    // The in-flight run cannot finish (or continue) a canceled row.
    expect(
      await smartDelayService.heartbeatClaim({ id: locked, generation: 1 }),
    ).toBe(false)
    expect(
      await smartDelayService.finishClaimedRun({ id: locked, generation: 1 }),
    ).toBe(false)
  })

  test("company-stop cancel (contact join) waits for the lock too", async () => {
    const workspaceId = mintId()
    const contactId = mintId()
    const contactInboxId = await insertContactInbox(contactId)
    const locked = await insertRow({
      status: "running",
      claimGeneration: 1,
      workspaceId,
      contactInboxId,
    })
    const other = await insertRow({
      status: "pending",
      workspaceId,
      contactInboxId,
    })
    // Another contact's row in the same workspace is left alone.
    const bystander = await insertRow({
      status: "pending",
      workspaceId,
      contactInboxId: await insertContactInbox(mintId()),
    })
    const holder = await holdRowLock(locked)

    const cancel = runSmartDelayCancelLoop({
      workspaceId,
      batchSize: 10,
      maxBatches: 50,
      logLabel: "s202-test",
      fetchBatch: (limit) =>
        smartDelayService.cancelActiveForContacts({
          workspaceId,
          contactIds: [contactId],
          limit,
        }),
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
    holder.release()
    await holder.done
    expect(await cancel).toBe(2)
    expect(await statusesOf([locked, other, bystander])).toEqual([
      "canceled",
      "canceled",
      "pending",
    ])
  })

  test("a batch cut short by a row that finished under the lock does not end the loop", async () => {
    const workspaceId = mintId()
    // Earliest triggerAt: the first batch waits on it, then drops it when the
    // holder commits `completed` (READ COMMITTED re-check of the status filter).
    const finishing = await insertRow({
      status: "running",
      claimGeneration: 1,
      workspaceId,
    })
    const rest = [
      await insertRow({ status: "pending", workspaceId }),
      await insertRow({ status: "pending", workspaceId }),
      await insertRow({ status: "pending", workspaceId }),
    ]
    const holder = await holdRowLock(finishing, async (tx) => {
      expect(
        await smartDelayService.finishClaimedRun({
          tx,
          id: finishing,
          generation: 1,
        }),
      ).toBe(true)
    })

    const cancel = cancelWorkspace(workspaceId, 2)
    await new Promise((resolve) => setTimeout(resolve, 300))
    holder.release()
    await holder.done
    expect(await cancel).toBe(3)
    expect(await statusesOf([finishing, ...rest])).toEqual([
      "completed",
      "canceled",
      "canceled",
      "canceled",
    ])
  })

  test("two cancel loops on one workspace never deadlock and cancel every row once (30 rounds)", async () => {
    for (let round = 0; round < 30; round++) {
      const workspaceId = mintId()
      const ids: string[] = []
      for (let i = 0; i < 12; i++) {
        ids.push(
          await insertRow({
            status: i % 3 === 0 ? "running" : "pending",
            claimGeneration: 1,
            workspaceId,
          }),
        )
      }
      const [a, b] = await Promise.all([
        cancelWorkspace(workspaceId, 5),
        cancelWorkspace(workspaceId, 5),
      ])
      expect(a + b, `round ${round}`).toBe(12)
      expect(new Set(await statusesOf(ids))).toEqual(new Set(["canceled"]))
    }
  })
})
