import {
  and,
  type DatabaseClient,
  db,
  eq,
  inArray,
  type Transaction,
} from "@chatbotx.io/database/client"
import { sequenceDispatchModel } from "@chatbotx.io/database/schema"
import { sequenceConnections } from "@chatbotx.io/redis"
import { SchedulerClient } from "@chatbotx.io/scheduler"

/**
 * Cancellation lives apart from `dispatch-manager` by responsibility: creating a
 * dispatch assigns a bucket and inserts a row, cancelling one only reads rows
 * back and clears their schedule entries. Both modules are Edge-safe now that
 * `dispatch-manager` bucketing no longer imports Node's `crypto`.
 */

type DrizzleClient = typeof db | Transaction
type ScheduledDispatch = { id: string; bucket: number }
type PendingDispatch = {
  bucket: number
  contactId: string
  id: string
  sequenceId: string
  stepId: string
}

type PendingDispatchWhere = {
  status: "pending"
  workspaceId: string
}

type CancelPendingDispatchesOptions = {
  client?: DrizzleClient
  removeFromSchedule?: boolean
  where: PendingDispatchWhere
}

const pendingDispatchColumns = {
  id: true,
  bucket: true,
  sequenceId: true,
  contactId: true,
  stepId: true,
} as const

async function cancelPendingDispatchesByWhere(
  options: CancelPendingDispatchesOptions,
): Promise<ScheduledDispatch[]> {
  const { client = db, removeFromSchedule = true, where } = options
  const pendingDispatches = (await client.query.sequenceDispatchModel.findMany({
    where,
    columns: pendingDispatchColumns,
  })) as PendingDispatch[]

  if (pendingDispatches.length === 0) {
    return []
  }

  const dispatchIds = pendingDispatches.map((dispatch) => dispatch.id)
  await client
    .update(sequenceDispatchModel)
    .set({
      status: "canceled",
      updatedAt: new Date(),
    })
    .where(
      and(
        inArray(sequenceDispatchModel.id, dispatchIds),
        eq(sequenceDispatchModel.workspaceId, where.workspaceId),
        eq(sequenceDispatchModel.status, "pending"),
      ),
    )

  if (removeFromSchedule) {
    await removeDispatchesFromSchedule(pendingDispatches)
  }

  return pendingDispatches.map((dispatch) => ({
    id: dispatch.id,
    bucket: dispatch.bucket,
  }))
}

export async function cancelPendingDispatchesForWorkspace(params: {
  client?: DatabaseClient | Transaction
  removeFromSchedule?: boolean
  workspaceId: string
}): Promise<ScheduledDispatch[]> {
  return await cancelPendingDispatchesByWhere({
    client: params.client,
    removeFromSchedule: params.removeFromSchedule,
    where: {
      status: "pending",
      workspaceId: params.workspaceId,
    },
  })
}

export async function removeDispatchesFromSchedule(
  dispatches: ScheduledDispatch[],
): Promise<void> {
  if (dispatches.length === 0) {
    return
  }

  const redisClient = await sequenceConnections.useExisting()
  const scheduler = new SchedulerClient(redisClient)

  const results = await Promise.allSettled(
    dispatches.map((dispatch) =>
      scheduler.removeFromSchedule(dispatch.bucket, dispatch.id),
    ),
  )
  const failures = results.flatMap((result, index) => {
    if (result.status !== "rejected") {
      return []
    }

    const dispatch = dispatches[index]
    if (!dispatch) {
      return []
    }

    return [{ dispatch, reason: result.reason }]
  })

  if (failures.length > 0) {
    const failedDispatches = failures
      .map(({ dispatch }) => `${dispatch.id} bucket=${dispatch.bucket}`)
      .join(", ")

    throw new AggregateError(
      failures.map(({ dispatch, reason }) => {
        const reasonMessage =
          reason instanceof Error ? reason.message : String(reason)
        return new Error(
          `Failed to remove ${dispatch.id} bucket=${dispatch.bucket}: ${reasonMessage}`,
        )
      }),
      `Failed to remove sequence dispatches from schedule: ${failedDispatches}`,
    )
  }
}

/**
 * Outreach B-1 (s226b): re-scores dispatches whose DB `runAtMs` moved LATER
 * (an out-of-office pause). ZADD upserts, so the old entry moves. Best
 * effort: the DB is authoritative, and the consumer re-queues a dispatch
 * that fires early at its DB time.
 */
export async function rescheduleDispatches(
  dispatches: (ScheduledDispatch & { runAtMs: string })[],
): Promise<void> {
  if (dispatches.length === 0) {
    return
  }
  const redisClient = await sequenceConnections.useExisting()
  const scheduler = new SchedulerClient(redisClient)
  await Promise.allSettled(
    dispatches.map((dispatch) =>
      scheduler.addToSchedule(
        dispatch.bucket,
        dispatch.id,
        Number(dispatch.runAtMs),
      ),
    ),
  )
}
