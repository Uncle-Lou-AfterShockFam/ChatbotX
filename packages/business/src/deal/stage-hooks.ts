import type { DealModel } from "@chatbotx.io/database/types"
import { logger } from "../logger"

export type StageEnteredContext = {
  workspaceId: string
  deal: DealModel
  stageId: string
  actorId: string | null
}
export type StageEnteredHandler = (ctx: StageEnteredContext) => Promise<void>

const handlers: StageEnteredHandler[] = []

/**
 * Register work that runs AFTER a deal's create / move transaction committed
 * and its event was emitted (task templates instantiate here). Kept apart
 * from the deal service so `deal-task` can depend on `deal` without a cycle;
 * `deal/index.ts` registers the task handler at module load.
 */
export function onStageEntered(handler: StageEnteredHandler): () => void {
  handlers.push(handler)
  return () => {
    const i = handlers.indexOf(handler)
    if (i >= 0) {
      handlers.splice(i, 1)
    }
  }
}

/** Runs every handler; a failure is logged and never un-does the deal write. */
export async function runStageEntered(ctx: StageEnteredContext): Promise<void> {
  for (const handler of handlers) {
    try {
      await handler(ctx)
    } catch (error) {
      logger.warn(
        { error, dealId: ctx.deal.id, stageId: ctx.stageId },
        "deal: stage-entered handler failed",
      )
    }
  }
}

/** Test seam. */
export function _resetStageEnteredHandlers(): void {
  handlers.length = 0
}
