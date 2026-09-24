import {
  and,
  type DatabaseClient,
  db,
  desc,
  eq,
} from "@chatbotx.io/database/client"
import type { CompanyActivityType } from "@chatbotx.io/database/partials"
import { companyActivityModel } from "@chatbotx.io/database/schema"
import type { CompanyActivityModel } from "@chatbotx.io/database/types"
import { createId } from "@chatbotx.io/utils"
import { logger } from "../logger"

export const MAX_COMPANY_ACTIVITY_PAGE = 200

/**
 * The company change log (s195 CRM 360). `record` is called BESIDE a write,
 * never inside its transaction when the write is a deal's: a failed log row
 * must not un-do a deal move (`recordSafely`). Company-side writes (create /
 * update / note / link) DO share the transaction: the log is part of the write.
 */
class CompanyActivityService {
  async record(props: {
    tx?: DatabaseClient
    workspaceId: string
    companyId: string
    type: CompanyActivityType
    actorId: string | null
    payload: Record<string, unknown>
  }): Promise<CompanyActivityModel> {
    const { tx = db } = props
    const [row] = await tx
      .insert(companyActivityModel)
      .values({
        id: createId(),
        workspaceId: props.workspaceId,
        companyId: props.companyId,
        type: props.type,
        actorId: props.actorId,
        // jsonb: written explicitly, never by a drizzle default (AGENTS.md)
        payload: props.payload,
      })
      .returning()
    return row
  }

  /** `record` that logs instead of throwing: for deal-side callers after their commit. */
  async recordSafely(props: {
    workspaceId: string
    companyId: string | null | undefined
    type: CompanyActivityType
    actorId: string | null
    payload: Record<string, unknown>
  }): Promise<void> {
    if (!props.companyId) {
      return
    }
    try {
      await this.record({ ...props, companyId: props.companyId })
    } catch (error) {
      logger.warn(
        { error, companyId: props.companyId, type: props.type },
        "company activity: record failed",
      )
    }
  }

  /** Newest first; the caller has already resolved the company in the workspace. */
  async list(props: {
    workspaceId: string
    companyId: string
    limit?: number
    tx?: DatabaseClient
  }): Promise<CompanyActivityModel[]> {
    const { workspaceId, companyId, tx = db } = props
    const limit = Math.min(
      Math.max(Math.trunc(props.limit ?? 50), 1),
      MAX_COMPANY_ACTIVITY_PAGE,
    )
    return await tx
      .select()
      .from(companyActivityModel)
      .where(
        and(
          eq(companyActivityModel.workspaceId, workspaceId),
          eq(companyActivityModel.companyId, companyId),
        ),
      )
      .orderBy(
        desc(companyActivityModel.createdAt),
        desc(companyActivityModel.id),
      )
      .limit(limit)
  }
}

export const companyActivityService = new CompanyActivityService()
