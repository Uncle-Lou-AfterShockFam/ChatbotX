import { type DatabaseClient, db } from "@chatbotx.io/database/client"
import type { ContactInboxModel } from "@chatbotx.io/database/types"

export const contactsOnSequencesUtils = {
  getAllSequenceIds: async (
    dbClient: DatabaseClient,
    where: { contactId: string },
  ): Promise<string[]> =>
    await dbClient.query.contactsOnSequenceModel
      .findMany({
        where,
        columns: {
          sequenceId: true,
        },
      })
      .then((sequences) => sequences.map((s) => s.sequenceId)),

  calculateSequenceDiff: (
    currentSequenceIds: string[],
    newSequenceIds: string[],
  ): { toAdd: string[]; toRemove: string[] } => {
    const currentSequenceIdSet = new Set(currentSequenceIds)
    const newSequenceIdSet = new Set(newSequenceIds)

    const toAdd = [...newSequenceIdSet].filter(
      (sequenceId) => !currentSequenceIdSet.has(sequenceId),
    )
    const toRemove = [...currentSequenceIdSet].filter(
      (sequenceId) => !newSequenceIdSet.has(sequenceId),
    )

    return { toAdd, toRemove }
  },
}

export type ContactsOnSequencesUtils = typeof contactsOnSequencesUtils

function activityMs(value: Date | string | null | undefined): number {
  if (!value) {
    return Number.NEGATIVE_INFINITY
  }
  const ms = new Date(value).getTime()
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms
}

/**
 * The contact inbox a sequence step dispatches to: AT MOST ONE (owner
 * s220b). A step runs its flow once per contact; a flow that must reach
 * several channels (a reminder by text AND email) says so in its own steps.
 * Upstream fanned out one dispatch per inbox, which duplicated such flows
 * and, with the inbox missing from the idempotency key, 500'd multi-inbox
 * subscribes. Picks the inbox the contact last wrote on, then the most
 * recently updated, then the highest id (deterministic).
 */
export async function getDispatchContactInboxes(
  workspaceId: string,
  contactId: string,
): Promise<ContactInboxModel[]> {
  const inboxes = await db.query.inboxModel.findMany({
    where: {
      workspaceId,
    },
    columns: {
      id: true,
    },
  })

  if (inboxes.length === 0) {
    return []
  }

  const contactInboxes = await db.query.contactInboxModel.findMany({
    where: {
      contactId,
      inboxId: {
        in: inboxes.map((inbox) => inbox.id),
      },
    },
  })

  const [primary] = [...contactInboxes].sort(
    (a, b) =>
      activityMs(b.lastIncomingMessageAt) -
        activityMs(a.lastIncomingMessageAt) ||
      activityMs(b.updatedAt) - activityMs(a.updatedAt) ||
      (BigInt(b.id) > BigInt(a.id) ? 1 : BigInt(b.id) < BigInt(a.id) ? -1 : 0),
  )
  return primary ? [primary] : []
}
