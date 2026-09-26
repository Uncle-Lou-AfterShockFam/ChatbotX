// @vitest-environment node

/**
 * `whatsappMessageTemplateRepository.listIdsByIntegrations` against a REAL
 * Postgres (s207). The broadcast form's WhatsApp-template flow picker passes
 * caller-supplied integration ids; the template table has no workspace, so
 * the query must scope through the integration: another workspace's
 * integration id yields none of its template ids.
 *
 * Seeds run under `SET LOCAL session_replication_role = replica` (no
 * Workspace / Inbox rows) and are deleted afterwards. Run with
 *
 *     DATABASE_URL=postgres://... pnpm --filter @chatbotx.io/business test:db
 */

import { db, sql } from "@chatbotx.io/database/client"
import { whatsappMessageTemplateRepository } from "@chatbotx.io/database/repositories"
import { requireRealDatabaseUrl } from "@chatbotx.io/vitest-config/real-db"
import { afterAll, afterEach, describe, expect, test } from "vitest"

const databaseUrl = requireRealDatabaseUrl()

/** Ids far above any snowflake a scratch database would hold (own range). */
let nextId = 9_215_000_000_000_000n
function mintId(): string {
  nextId += 1n
  return nextId.toString()
}

const seeded: Record<string, string[]> = {
  WhatsappMessageTemplate: [],
  IntegrationWhatsapp: [],
}

async function asReplica(statement: ReturnType<typeof sql>): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`)
    await tx.execute(statement)
  })
}

/** One integration in `workspaceId` with `templates` template rows. */
async function seedIntegration(workspaceId: string, templates: number) {
  const integrationId = mintId()
  await asReplica(sql`
    INSERT INTO "IntegrationWhatsapp"
      (id, auth, "phoneNumberId", "wabaId", "businessId", name,
       "workspaceId", "inboxId")
    VALUES (${integrationId}, '{}'::jsonb, ${`s207-${integrationId}`},
            'waba', 'biz', 's207 line', ${workspaceId}, ${mintId()})`)
  seeded.IntegrationWhatsapp?.push(integrationId)
  const templateIds: string[] = []
  for (let i = 0; i < templates; i++) {
    const templateId = mintId()
    await asReplica(sql`
      INSERT INTO "WhatsappMessageTemplate"
        (id, name, "integrationWhatsappId", "sourceId", language, category,
         status)
      VALUES (${templateId}, ${`t${templateId}`}, ${integrationId},
              ${`src-${templateId}`}, 'en_US', 'MARKETING', 'APPROVED')`)
    seeded.WhatsappMessageTemplate?.push(templateId)
    templateIds.push(templateId)
  }
  return { integrationId, templateIds }
}

afterEach(async () => {
  if (!databaseUrl) {
    return
  }
  for (const table of ["WhatsappMessageTemplate", "IntegrationWhatsapp"]) {
    const ids = seeded[table]?.splice(0) ?? []
    if (ids.length > 0) {
      await asReplica(sql`
        DELETE FROM ${sql.identifier(table)}
         WHERE id IN (${sql.join(
           ids.map((id) => sql`${id}`),
           sql`, `,
         )})`)
    }
  }
})

afterAll(async () => {
  if (!databaseUrl) {
    return
  }
  await db.$client.end()
})

describe.skipIf(!databaseUrl)(
  "whatsappMessageTemplateRepository.listIdsByIntegrations (real Postgres)",
  () => {
    test("returns the templates of every listed integration of the workspace", async () => {
      const workspaceId = mintId()
      const a = await seedIntegration(workspaceId, 2)
      const b = await seedIntegration(workspaceId, 1)

      const ids = await whatsappMessageTemplateRepository.listIdsByIntegrations(
        {
          workspaceId,
          integrationWhatsappIds: [a.integrationId, b.integrationId],
        },
      )

      expect(ids.toSorted()).toEqual(
        [...a.templateIds, ...b.templateIds].toSorted(),
      )
    })

    test("another workspace's integration id yields none of its templates", async () => {
      const workspaceId = mintId()
      const mine = await seedIntegration(workspaceId, 1)
      const foreign = await seedIntegration(mintId(), 2)

      const ids = await whatsappMessageTemplateRepository.listIdsByIntegrations(
        {
          workspaceId,
          integrationWhatsappIds: [mine.integrationId, foreign.integrationId],
        },
      )

      expect(ids).toEqual(mine.templateIds)
    })

    test("an empty id list is empty", async () => {
      expect(
        await whatsappMessageTemplateRepository.listIdsByIntegrations({
          workspaceId: mintId(),
          integrationWhatsappIds: [],
        }),
      ).toEqual([])
    })
  },
)
