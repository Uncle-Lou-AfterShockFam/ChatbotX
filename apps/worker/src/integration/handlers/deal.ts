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

const OWNER_NOT_MEMBER = /owner is not a member/i

/** The service's 422 for an `ownerId` that is not a workspace member. */
function isOwnerNotMember(error: unknown): boolean {
  return error instanceof Error && OWNER_NOT_MEMBER.test(error.message)
}

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
      ownerId: step.ownerId || null,
      dueAt:
        step.dueInDays === null || step.dueInDays === undefined
          ? null
          : new Date(Date.now() + step.dueInDays * 86_400_000),
    }
    const write = (input: typeof data) =>
      step.skipIfOpenDealExists
        ? // The check and the insert share one advisory lock in the service,
          // so two flow runs for the same contact cannot both create a deal.
          dealService.createUnlessOpen({ workspaceId, data: input })
        : dealService
            .create({ workspaceId, data: input })
            .then((deal) => ({ deal, created: true }))
    let result: Awaited<ReturnType<typeof write>>
    try {
      result = await write(data)
    } catch (error) {
      // A configured owner who has since left the workspace must not turn
      // every run of this step into a silent no-deal: retry ownerless.
      if (!(data.ownerId && isOwnerNotMember(error))) {
        throw error
      }
      logger.warn(
        { workspaceId, contactId, stepId: step.id, ownerId: data.ownerId },
        "createDeal: configured owner is no longer a workspace member; creating the deal without an owner",
      )
      result = await write({ ...data, ownerId: null })
    }
    logger.info(
      {
        workspaceId,
        contactId,
        dealId: result.deal.id,
        stepId: step.id,
        created: result.created,
      },
      result.created
        ? "createDeal: deal created"
        : "createDeal: contact already has an open deal in this pipeline; skipped",
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
