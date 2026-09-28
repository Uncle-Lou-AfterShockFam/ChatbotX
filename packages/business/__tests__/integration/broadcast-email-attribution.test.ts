// @vitest-environment node

/**
 * SMTP email-step sends attributed to their broadcast (s220b), against a REAL
 * Postgres. A recipient row created with `broadcastId` stamps the recipient's
 * ContactOnBroadcast row on its first delivery / open / click / failure, so
 * the existing broadcast stats count email like every other channel. A send
 * outside a broadcast (no `broadcastId`) never touches ContactOnBroadcast.
 *
 *     DATABASE_URL=postgres://... pnpm --filter @chatbotx.io/business test:db
 */

import {
  broadcastStatsRepository,
  emailTopicStatsRepository,
} from "@chatbotx.io/analytics"
import { db, sql } from "@chatbotx.io/database/client"
import { requireRealDatabaseUrl } from "@chatbotx.io/vitest-config/real-db"
import { afterAll, afterEach, describe, expect, test } from "vitest"

const databaseUrl = requireRealDatabaseUrl()

let nextId = 9_222_000_000_000_000n
function mintId(): string {
  nextId += 1n
  return nextId.toString()
}

const broadcasts: string[] = []
const topics: string[] = []
const owners: Array<{
  workspaceId: string
  contactId: string
  contactInboxId: string
}> = []

async function asReplica(statement: ReturnType<typeof sql>): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`)
    await tx.execute(statement)
  })
}

/** One broadcast with one recipient row, plus an email topic. */
async function seed() {
  const workspaceId = mintId()
  const broadcastId = mintId()
  const topicId = mintId()
  const contactId = mintId()
  const contactInboxId = mintId()
  await asReplica(sql`
    INSERT INTO "Workspace" (id, name, "ownerId")
    VALUES (${workspaceId}, ${`s220b ${workspaceId}`}, 1)`)
  await asReplica(sql`
    INSERT INTO "Contact" (id, "workspaceId") VALUES (${contactId}, ${workspaceId})`)
  await asReplica(sql`
    INSERT INTO "ContactInbox"
      (id, "originalContactId", "contactId", "inboxId", channel, source, "sourceId")
    VALUES (${contactInboxId}, ${contactId}, ${contactId}, 1, 'api', 'api',
            ${`s220b-${contactInboxId}`})`)
  owners.push({ workspaceId, contactId, contactInboxId })
  await asReplica(sql`
    INSERT INTO "Broadcast"
      (id, name, "workspaceId", status, "schedulesType", "schedulesAt", subaction, channel)
    VALUES (${broadcastId}, 's220b', ${workspaceId}, 'sending', 'now', now(), 'flow', 'allContacts')`)
  broadcasts.push(broadcastId)
  await asReplica(sql`
    INSERT INTO "ContactOnBroadcast"
      ("broadcastId", "contactId", "contactInboxId", "conversationId", sent)
    VALUES (${broadcastId}, ${contactId}, ${contactInboxId}, 1, true)`)
  await asReplica(sql`
    INSERT INTO "EmailTopic" (id, name, "workspaceId")
    VALUES (${topicId}, ${`s220b ${topicId}`}, ${workspaceId})`)
  topics.push(topicId)
  return { workspaceId, broadcastId, topicId, contactId, contactInboxId }
}

async function cob(broadcastId: string) {
  const result = await db.execute<{
    deliveredAt: Date | null
    seenAt: Date | null
    clickedAt: Date | null
    failedAt: Date | null
    errorContent: string | null
  }>(sql`
    SELECT "deliveredAt", "seenAt", "clickedAt", "failedAt", "errorContent"
      FROM "ContactOnBroadcast" WHERE "broadcastId" = ${broadcastId}`)
  return result.rows[0]
}

afterEach(async () => {
  if (!databaseUrl) {
    return
  }
  for (const id of topics.splice(0)) {
    await asReplica(
      sql`DELETE FROM "AnalyticsEmailTopic" WHERE "topicId" = ${id}`,
    )
    await asReplica(sql`DELETE FROM "EmailTopic" WHERE id = ${id}`)
  }
  for (const id of broadcasts.splice(0)) {
    await asReplica(
      sql`DELETE FROM "ContactOnBroadcast" WHERE "broadcastId" = ${id}`,
    )
    await asReplica(sql`DELETE FROM "Broadcast" WHERE id = ${id}`)
  }
  for (const o of owners.splice(0)) {
    await asReplica(
      sql`DELETE FROM "ContactInbox" WHERE id = ${o.contactInboxId}`,
    )
    await asReplica(sql`DELETE FROM "Contact" WHERE id = ${o.contactId}`)
    await asReplica(sql`DELETE FROM "Workspace" WHERE id = ${o.workspaceId}`)
  }
})

afterAll(async () => {
  if (!databaseUrl) {
    return
  }
  await db.$client.end()
})

describe.skipIf(!databaseUrl)("broadcast email attribution", () => {
  test("delivery, open and click stamp ContactOnBroadcast and reach the stats", async () => {
    const s = await seed()
    const { token } = await emailTopicStatsRepository.createRecipient({
      topicId: s.topicId,
      workspaceId: s.workspaceId,
      email: "s220b@example.test",
      contactId: s.contactId,
      contactInboxId: s.contactInboxId,
      broadcastId: s.broadcastId,
    })

    await emailTopicStatsRepository.markDelivered(token)
    await emailTopicStatsRepository.recordOpen(token)
    await emailTopicStatsRepository.recordClick(token)
    // Repeats never move the first-time stamps.
    const first = await cob(s.broadcastId)
    await emailTopicStatsRepository.recordOpen(token)
    await emailTopicStatsRepository.recordClick(token)
    const after = await cob(s.broadcastId)

    expect(first?.deliveredAt).toBeTruthy()
    expect(first?.seenAt).toBeTruthy()
    expect(first?.clickedAt).toBeTruthy()
    expect(after).toEqual(first)

    const stats = await broadcastStatsRepository.getStats({
      workspaceId: s.workspaceId,
      broadcastId: s.broadcastId,
    })
    expect(stats["message:delivered"]).toBe(1)
    expect(stats["message:seen"]).toBe(1)
    expect(stats["flow:clicked"]).toBe(1)
    expect(stats["message:sent"]).toBe(1)
  })

  test("a failed send stamps failedAt with an error", async () => {
    const s = await seed()
    const { token } = await emailTopicStatsRepository.createRecipient({
      topicId: s.topicId,
      workspaceId: s.workspaceId,
      email: "s220b@example.test",
      contactId: s.contactId,
      contactInboxId: s.contactInboxId,
      broadcastId: s.broadcastId,
    })

    await emailTopicStatsRepository.markFailed(token)

    const row = await cob(s.broadcastId)
    expect(row?.failedAt).toBeTruthy()
    expect(row?.errorContent).toBe(
      JSON.stringify({ error: "smtp-send-failed" }),
    )
  })

  test("a send outside a broadcast never touches ContactOnBroadcast", async () => {
    const s = await seed()
    const { token } = await emailTopicStatsRepository.createRecipient({
      topicId: s.topicId,
      workspaceId: s.workspaceId,
      email: "s220b@example.test",
      contactId: s.contactId,
      contactInboxId: s.contactInboxId,
    })

    await emailTopicStatsRepository.markDelivered(token)
    await emailTopicStatsRepository.recordOpen(token)
    await emailTopicStatsRepository.recordClick(token)
    await emailTopicStatsRepository.markFailed(token)

    expect(await cob(s.broadcastId)).toEqual({
      deliveredAt: null,
      seenAt: null,
      clickedAt: null,
      failedAt: null,
      errorContent: null,
    })
  })
})
