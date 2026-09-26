import { conversationService } from "@chatbotx.io/business"
import { emit } from "@chatbotx.io/event-bus"
import type { FlowNode } from "@chatbotx.io/flow-config"
import { initVariables, SdkException } from "@chatbotx.io/sdk"
import type { IntegrationJobRunChallenge } from "@chatbotx.io/worker-config"
import type { Job } from "bullmq"
import {
  detectConversationAndContactInbox,
  detectFlowVersion,
} from "../../lib/db"
import { COMPANY_STOPPED, resolveRunStartedAt } from "./company-stop-guard"
import { runStepsAndQuickReplies } from "./flow"

export async function runChallenge(
  data: IntegrationJobRunChallenge["data"],
  job: Pick<Job, "timestamp">,
) {
  const {
    conversationId,
    contactInboxId,
    challenge,
    messageId,
    messageCreatedAt,
  } = data

  if (challenge.type !== "step") {
    return
  }

  const { conversation, contactInbox } =
    await detectConversationAndContactInbox({
      conversationId,
      contactInboxId,
    })

  const startTime = Date.now()
  try {
    const { flowVersion, useLatestFlowVersion } = await detectFlowVersion({
      flowId: challenge.data.flowId,
      flowVersionId: challenge.data.flowVersionId,
      workspaceId: conversation.workspaceId,
    })

    const targetNode = (flowVersion.nodes as unknown as FlowNode[]).find(
      (node) => node.id === challenge.data.nodeId,
    )
    if (!targetNode) {
      throw new SdkException("Target node not found")
    }

    if (!("steps" in targetNode.data.details)) {
      throw new SdkException("Target node does not have steps")
    }
    const targetStepIdx = targetNode.data.details.steps.findIndex(
      (step) => step.id === challenge.data.stepId,
    )
    if (targetStepIdx === -1) {
      throw new SdkException("Target step not found")
    }

    const variables = initVariables()
    variables.conversation.challengeAttempts = {
      name: "challengeAttempts",
      type: "number",
      value: challenge.data.attempts,
    }
    variables.conversation.challengeLastAttemptAt = {
      name: "challengeLastAttemptAt",
      type: "date",
      value: challenge.data.lastAttemptAt,
    }

    const outcome = await runStepsAndQuickReplies({
      conversation,
      contactInbox,
      flowVersion,
      useLatestFlowVersion,
      details: targetNode.data.details,
      targetType: "node",
      targetId: targetNode.id,
      startFromStepId: challenge.data.stepId,
      ctx: {
        variables,
      },
      triggerMessageId: messageId,
      triggerMessageCreatedAt: messageCreatedAt,
      appointmentId: challenge.data.appointmentId,
      // The run that asked, not this reply: a pre-stop question stays stopped.
      // A challenge written before runStartedAt existed: when it was asked.
      runStartedAt: resolveRunStartedAt(
        challenge.data.runStartedAt ?? challenge.data.lastAttemptAt,
        job.timestamp,
      ),
    })

    if (outcome === COMPANY_STOPPED) {
      // The run that asked is over: a pending challenge would route every
      // later inbound message here (and block automated replies) for good.
      await conversationService.updateChallenge({
        workspaceId: conversation.workspaceId,
        conversationId: conversation.id,
        challenge: undefined,
      })
      return
    }

    if (messageId) {
      emit("analytics:dashboard", {
        eventType: "message:bot_received",
        workspaceId: conversation.workspaceId,
        conversationId: conversation.id,
        messageId,
        occurredAt: new Date(),
        hasResponse: true,
        responseType: "flow",
        routeType: "flow",
        result: "success",
        aiProvider: "none",
        metadata: {
          latency: Date.now() - startTime,
          flowId: challenge.data.flowId,
          triggerContext: {
            triggerSource: "worker",
            triggerHandler: "runChallenge",
            triggerType: "challenge_step",
          },
        },
      })
    }
  } catch (error) {
    if (messageId) {
      emit("analytics:dashboard", {
        eventType: "message:bot_received",
        workspaceId: conversation.workspaceId,
        conversationId: conversation.id,
        messageId,
        occurredAt: new Date(),
        hasResponse: false,
        responseType: "flow",
        routeType: "flow",
        result: "fallback",
        aiProvider: "none",
        metadata: {
          latency: Date.now() - startTime,
          flowId: challenge.data.flowId,
          fallbackReason: "handler_error_to_fallback",
          triggerContext: {
            triggerSource: "worker",
            triggerHandler: "runChallenge",
            triggerType: "challenge_step_failed",
          },
        },
      })
    }
    throw error
  }
}
