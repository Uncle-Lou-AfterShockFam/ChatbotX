import {
  flowAnalyticsService,
  flowNodeStatsResponse,
  flowStatsRequest,
} from "@chatbotx.io/analytics"
import { flowVersionService } from "@chatbotx.io/business"
import { convertStartNodeToMessengerAdsJson } from "@chatbotx.io/integration-messenger/messenger-ads"
import { zodBigintAsString } from "@chatbotx.io/utils"
import z from "zod"
import { flowVersionResource } from "@/features/flow-versions/schema/resource"
import { withWorkspaceIdSchema } from "@/features/workspaces/schema/resource"
import { hasWorkspacePermission } from "@/lib/auth/permission-routes"
import {
  flowsAuthorizedMiddleware,
  workspaceAuthorizedMidddleware,
} from "@/middlewares/auth"
import { authorizedAPI } from "@/orpc"
import { toFlowPickerResource } from "../lib/flow-picker-resource"
import { listFlows } from "../queries"
import { listFlowsRequest, listFlowsResponse } from "../schema/query"

export const privateFlowsAPI = {
  privateListFlowsAPI: authorizedAPI
    .route({
      method: "GET",
      path: "/workspaces/{workspaceId}/flows",
      summary: "List flows",
      tags: ["Flows"],
    })
    .input(listFlowsRequest.and(withWorkspaceIdSchema))
    // Membership only: the flow pickers outside the flows pages use this
    // list; without `flows` the step config is projected away (s234a).
    .use(workspaceAuthorizedMidddleware, (input) => input.workspaceId)
    .output(listFlowsResponse)
    .handler(async ({ input, context }) => {
      const { workspaceId, ...rest } = input

      const result = await listFlows({ ...rest, workspaceId })
      return hasWorkspacePermission(context.member.permissions, "flows")
        ? result
        : { ...result, data: result.data.map(toFlowPickerResource) }
    }),

  privateGetFlowStatsAPI: authorizedAPI
    .route({
      method: "GET",
      path: "/workspaces/{workspaceId}/flows/{flowId}/stats",
      summary: "Get flow stats",
      tags: ["Flows"],
    })
    .input(flowStatsRequest)
    .output(flowNodeStatsResponse)
    .use(flowsAuthorizedMiddleware, (input) => input.workspaceId)
    .handler(
      async ({ input }) =>
        await flowAnalyticsService.getFlowStats({
          workspaceId: input.workspaceId,
          flowId: input.flowId,
        }),
    ),

  privateListFlowVersionsAPI: authorizedAPI
    .route({
      method: "GET",
      path: "/workspaces/{workspaceId}/flows/{flowId}/versions",
      summary: "List flow versions",
      tags: ["Flows"],
    })
    .input(withWorkspaceIdSchema.and(z.object({ flowId: zodBigintAsString() })))
    .use(flowsAuthorizedMiddleware, (input) => input.workspaceId)
    .output(z.array(flowVersionResource))
    .handler(async ({ input }) =>
      flowVersionService.list({
        flowId: input.flowId,
        workspaceId: input.workspaceId,
      }),
    ),

  privateGetMessengerAdsJsonAPI: authorizedAPI
    .route({
      method: "GET",
      path: "/workspaces/{workspaceId}/flows/{flowId}/messenger-ads-json",
      summary: "Get Messenger Ads JSON",
      tags: ["Flows"],
    })
    .input(withWorkspaceIdSchema.and(z.object({ flowId: zodBigintAsString() })))
    .use(flowsAuthorizedMiddleware, (input) => input.workspaceId)
    .output(
      z.discriminatedUnion("status", [
        z.object({ status: z.literal("ok"), json: z.string() }),
        z.object({
          status: z.literal("error"),
          reason: z.enum([
            "notPublished",
            "noStartNode",
            "invalidStepType",
            "invalidVariable",
          ]),
        }),
      ]),
    )
    .handler(async ({ input }) => {
      const published = await flowVersionService.getMessengerAdsStartNode({
        flowId: input.flowId,
        workspaceId: input.workspaceId,
      })

      // "Unpublished changes" is detected client-side (a toast fires before this
      // is called). Here we surface the two states the converter can't handle,
      // kept distinct so the client shows the right guidance: no published
      // version at all vs. published but no resolvable start node.
      if (published.status !== "ok") {
        return { status: "error" as const, reason: published.status }
      }

      const result = convertStartNodeToMessengerAdsJson({
        startNode: published.startNode,
        flowId: input.flowId,
        flowVersionId: published.flowVersionId,
      })

      if (result.status === "error") {
        return { status: "error" as const, reason: result.reason }
      }

      return { status: "ok" as const, json: JSON.stringify(result.messages) }
    }),

  privateResetFlowStatsAPI: authorizedAPI
    .route({
      method: "DELETE",
      path: "/workspaces/{workspaceId}/flows/{flowId}/stats",
      summary: "Reset flow stats",
      tags: ["Flows"],
    })
    .input(flowStatsRequest)
    .use(flowsAuthorizedMiddleware, (input) => input.workspaceId)
    .handler(async ({ input }) => {
      await flowAnalyticsService.resetStatsSession({
        workspaceId: input.workspaceId,
        flowId: input.flowId,
      })
    }),
}
