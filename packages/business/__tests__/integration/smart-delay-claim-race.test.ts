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

import { db, sql } from "@chatbotx.io/database/client"
import { afterAll, afterEach, describe, expect, test } from "vitest"
import { MAX_RESUME_CLAIMS, smartDelayService } from "../../src/smart-delay"

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

type RowState = {
  status: string
  claimGeneration: number
  nodeId: string | null
}

async function insertRow(props: {
  status: "pending" | "scheduled" | "running"
  claimGeneration?: number
}): Promise<string> {
  nextId += 1n
  const id = nextId.toString()
  const generation = props.claimGeneration ?? 0
  await db.transaction(async (tx) => {
    // Transaction-scoped: the pooled connection goes back with FKs enforced.
    await tx.execute(sql`SET LOCAL session_replication_role = replica`)
    await tx.execute(sql`
      INSERT INTO "ContactOnSmartDelay"
        (id, "workspaceId", "flowId", "contactInboxId", "conversationId",
         "nodeId", "eventNodeId", type, "triggerAt", status,
         "claimGeneration", "claimedAt")
      VALUES (${id}, 1, 1, 1, 1, 'timeout-edge', 'event-edge', 'waitForEvent',
              now() + interval '1 hour', ${props.status}::"ContactOnSmartDelayStatus",
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

describe.skipIf(!databaseUrl)("smart delay claim CAS on real Postgres", () => {
  afterEach(async () => {
    if (seeded.length > 0) {
      const ids = seeded.splice(0)
      await db.execute(sql`
        DELETE FROM "ContactOnSmartDelay"
         WHERE id IN (${sql.join(
           ids.map((id) => sql`${id}`),
           sql`, `,
         )})`)
    }
  })

  afterAll(async () => {
    await db.$client.end()
  })

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
