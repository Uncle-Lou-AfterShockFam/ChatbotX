import { dealService } from "@chatbotx.io/business/deal"
import type {
  CreateDealStepSchema,
  MoveDealStageStepSchema,
  SetDealStatusStepSchema,
} from "@chatbotx.io/flow-config"
import { contactVariableService } from "@chatbotx.io/variables"
import { logger } from "../../lib/logger"
import type { ExecuteStepProps } from "./flow-utils"

/**
 * Deal steps run for the conversation's contact. Like the other contact
 * steps they never throw: a step that fails would kill the BullMQ job and
 * silently drop the rest of the node, so every failure is logged and the
 * flow continues.
 */

export async function createDeal({
  conversation,
  contactInbox,
  step,
}: ExecuteStepProps<CreateDealStepSchema>) {
  const { workspaceId, contactId } = conversation
  if (!step.pipelineId) {
    logger.warn({ workspaceId, stepId: step.id }, "createDeal: no pipeline set")
    return
  }
  try {
    const variables = await contactVariableService.getAll({
      contactId,
      contactInbox,
      conversation,
    })
    const [title, value] = await Promise.all([
      contactVariableService.replaceAll({ text: step.title, variables }),
      contactVariableService.replaceAll({ text: step.value, variables }),
    ])
    const data = {
      pipelineId: step.pipelineId,
      stageId: step.stageId || null,
      title: title.trim().length > 0 ? title : `Deal for ${contactId}`,
      value: value.trim().length > 0 ? value : null,
      currency: step.currency.trim().length > 0 ? step.currency : null,
      priority: step.priority,
      contactId,
    }
    if (step.skipIfOpenDealExists) {
      // The check and the insert share one advisory lock in the service, so two
      // flow runs for the same contact cannot both create a deal.
      const { deal, created } = await dealService.createUnlessOpen({
        workspaceId,
        data,
      })
      logger.info(
        { workspaceId, contactId, dealId: deal.id, stepId: step.id, created },
        created
          ? "createDeal: deal created"
          : "createDeal: contact already has an open deal in this pipeline; skipped",
      )
      return
    }
    const deal = await dealService.create({ workspaceId, data })
    logger.info(
      { workspaceId, contactId, dealId: deal.id, stepId: step.id },
      "createDeal: deal created",
    )
  } catch (error) {
    logger.error(
      { err: error, workspaceId, contactId, stepId: step.id },
      "createDeal step failed; continuing with the remaining steps",
    )
  }
}

export async function moveDealStage({
  conversation,
  step,
}: ExecuteStepProps<MoveDealStageStepSchema>) {
  const { workspaceId, contactId } = conversation
  if (!(step.pipelineId && step.stageId)) {
    logger.warn(
      { workspaceId, stepId: step.id },
      "moveDealStage: pipeline or stage not set",
    )
    return
  }
  try {
    const open = await dealService.findOpenForContactInPipeline({
      workspaceId,
      contactId,
      pipelineId: step.pipelineId,
    })
    if (!open) {
      logger.info(
        { workspaceId, contactId, stepId: step.id },
        "moveDealStage: no open deal for this contact in the pipeline",
      )
      return
    }
    await dealService.moveStage({
      workspaceId,
      id: open.id,
      stageId: step.stageId,
    })
  } catch (error) {
    logger.error(
      { err: error, workspaceId, contactId, stepId: step.id },
      "moveDealStage step failed; continuing with the remaining steps",
    )
  }
}

export async function setDealStatus({
  conversation,
  step,
}: ExecuteStepProps<SetDealStatusStepSchema>) {
  const { workspaceId, contactId } = conversation
  if (!step.pipelineId) {
    logger.warn(
      { workspaceId, stepId: step.id },
      "setDealStatus: no pipeline set",
    )
    return
  }
  try {
    const open = await dealService.findOpenForContactInPipeline({
      workspaceId,
      contactId,
      pipelineId: step.pipelineId,
    })
    if (!open) {
      logger.info(
        { workspaceId, contactId, stepId: step.id },
        "setDealStatus: no open deal for this contact in the pipeline",
      )
      return
    }
    await dealService.setStatus({
      workspaceId,
      id: open.id,
      status: step.status,
    })
  } catch (error) {
    logger.error(
      { err: error, workspaceId, contactId, stepId: step.id },
      "setDealStatus step failed; continuing with the remaining steps",
    )
  }
}
