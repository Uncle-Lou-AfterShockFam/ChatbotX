import { onStageEntered } from "../deal/stage-hooks"
import { dealTaskService } from "./service"
import { dealTaskTemplateService } from "./templates"

/**
 * Wire template instantiation to every stage entry. Imported by the `deal`
 * barrel so any process that can move a deal also instantiates its templates.
 */
export function registerDealTaskHooks(): () => void {
  return onStageEntered(async ({ workspaceId, deal, stageId, actorId }) => {
    const templates = await dealTaskTemplateService.listForStage({
      workspaceId,
      pipelineId: deal.pipelineId,
      stageId,
    })
    if (templates.length === 0) {
      return
    }
    await dealTaskService.instantiateForStage({
      workspaceId,
      deal,
      stageId,
      actorId,
      templates,
    })
  })
}
