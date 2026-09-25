import {
  dealTaskService,
  dealTaskTemplateService,
} from "@chatbotx.io/business/deal-task"
import { zodBigintAsString } from "@chatbotx.io/utils"
import z from "zod"
import { viewerFromContext } from "@/features/deals/lib/viewer"
import { withWorkspaceIdSchema } from "@/features/workspaces/schema/resource"
import { contactsAccessAuthorizedMiddleware } from "@/middlewares/auth"
import { authorizedAPI } from "@/orpc"
import {
  addDealDependencyRequest,
  addTaskTemplateDependencyRequest,
  completeDealTaskRequest,
  createDealTaskRequest,
  updateDealTaskRequest,
  upsertDealTaskTemplateRequest,
} from "../schema/action"
import {
  dealTaskResource,
  dealTaskTemplateResource,
  dealTaskUpdateResource,
  dealTaskWithBlockersResource,
} from "../schema/resource"

const withDealId = withWorkspaceIdSchema.and(
  z.object({ id: zodBigintAsString() }),
)
const withTaskId = withDealId.and(z.object({ taskId: zodBigintAsString() }))
const withStage = withWorkspaceIdSchema.and(
  z.object({ pipelineId: zodBigintAsString(), stageId: zodBigintAsString() }),
)

const privateListDealTasksAPI = authorizedAPI
  .route({
    method: "GET",
    path: "/workspaces/{workspaceId}/deals/{id}/tasks",
    summary: "Tasks of a deal with their open blockers",
    tags: ["Deals"],
  })
  .input(withDealId)
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(z.object({ data: z.array(dealTaskWithBlockersResource) }))
  .handler(async ({ input, context }) => ({
    data: await dealTaskService.list({
      workspaceId: input.workspaceId,
      dealId: input.id,
      viewer: viewerFromContext(context),
    }),
  }))

const privateCreateDealTaskAPI = authorizedAPI
  .route({
    method: "POST",
    path: "/workspaces/{workspaceId}/deals/{id}/tasks",
    summary: "Add a task to a deal",
    tags: ["Deals"],
  })
  .input(createDealTaskRequest.and(withDealId))
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(dealTaskResource)
  .handler(async ({ input, context }) => {
    const { workspaceId, id, ...data } = input
    return await dealTaskService.create({
      workspaceId,
      dealId: id,
      data,
      actorId: context.user.id,
      viewer: viewerFromContext(context),
    })
  })

const privateUpdateDealTaskAPI = authorizedAPI
  .route({
    method: "PATCH",
    path: "/workspaces/{workspaceId}/deals/{id}/tasks/{taskId}",
    summary: "Update a task",
    tags: ["Deals"],
  })
  .input(updateDealTaskRequest.and(withTaskId))
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(dealTaskUpdateResource)
  .handler(async ({ input, context }) => {
    const { workspaceId, id, taskId, ...data } = input
    return await dealTaskService.update({
      workspaceId,
      dealId: id,
      taskId,
      data,
      actorId: context.user.id,
      viewer: viewerFromContext(context),
    })
  })

const privateCompleteDealTaskAPI = authorizedAPI
  .route({
    method: "POST",
    path: "/workspaces/{workspaceId}/deals/{id}/tasks/{taskId}/complete",
    summary: "Complete a task",
    tags: ["Deals"],
  })
  .input(completeDealTaskRequest.and(withTaskId))
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(z.object({ task: dealTaskResource, completed: z.boolean() }))
  .handler(async ({ input, context }) => {
    const { workspaceId, id, taskId, force } = input
    return await dealTaskService.complete({
      workspaceId,
      dealId: id,
      taskId,
      force,
      actorId: context.user.id,
      viewer: viewerFromContext(context),
    })
  })

const privateReopenDealTaskAPI = authorizedAPI
  .route({
    method: "POST",
    path: "/workspaces/{workspaceId}/deals/{id}/tasks/{taskId}/reopen",
    summary: "Reopen a completed task",
    tags: ["Deals"],
  })
  .input(withTaskId)
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(dealTaskResource)
  .handler(
    async ({ input, context }) =>
      await dealTaskService.reopen({
        workspaceId: input.workspaceId,
        dealId: input.id,
        taskId: input.taskId,
        viewer: viewerFromContext(context),
      }),
  )

const privateDeleteDealTaskAPI = authorizedAPI
  .route({
    method: "DELETE",
    path: "/workspaces/{workspaceId}/deals/{id}/tasks/{taskId}",
    summary: "Delete a task",
    tags: ["Deals"],
  })
  .input(withTaskId)
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(z.object({ deleted: z.literal(true) }))
  .handler(async ({ input, context }) => {
    await dealTaskService.remove({
      workspaceId: input.workspaceId,
      dealId: input.id,
      taskId: input.taskId,
      viewer: viewerFromContext(context),
    })
    return { deleted: true as const }
  })

const privateAddDealDependencyAPI = authorizedAPI
  .route({
    method: "POST",
    path: "/workspaces/{workspaceId}/deals/{id}/tasks/{taskId}/dependencies",
    summary: "Make a task wait on another task of the deal",
    tags: ["Deals"],
  })
  .input(addDealDependencyRequest.and(withTaskId))
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(z.object({ taskId: z.string(), dependsOnTaskId: z.string() }))
  .handler(async ({ input, context }) => {
    const row = await dealTaskService.addDependency({
      workspaceId: input.workspaceId,
      dealId: input.id,
      taskId: input.taskId,
      dependsOnTaskId: input.dependsOnTaskId,
      viewer: viewerFromContext(context),
    })
    return { taskId: row.taskId, dependsOnTaskId: row.dependsOnTaskId }
  })

const privateRemoveDealDependencyAPI = authorizedAPI
  .route({
    method: "DELETE",
    path: "/workspaces/{workspaceId}/deals/{id}/tasks/{taskId}/dependencies/{dependsOnTaskId}",
    summary: "Remove a dependency",
    tags: ["Deals"],
  })
  .input(withTaskId.and(z.object({ dependsOnTaskId: zodBigintAsString() })))
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(z.object({ removed: z.boolean() }))
  .handler(
    async ({ input, context }) =>
      await dealTaskService.removeDependency({
        workspaceId: input.workspaceId,
        dealId: input.id,
        taskId: input.taskId,
        dependsOnTaskId: input.dependsOnTaskId,
        viewer: viewerFromContext(context),
      }),
  )

const privateListPipelineTaskTemplatesAPI = authorizedAPI
  .route({
    method: "GET",
    path: "/workspaces/{workspaceId}/pipelines/{pipelineId}/task-templates",
    summary: "Task templates of every stage of a pipeline",
    tags: ["Pipelines"],
  })
  .input(
    withWorkspaceIdSchema.and(z.object({ pipelineId: zodBigintAsString() })),
  )
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(z.object({ data: z.array(dealTaskTemplateResource) }))
  .handler(async ({ input, context }) => ({
    data: await dealTaskTemplateService.listForPipeline({
      ...input,
      viewer: viewerFromContext(context),
    }),
  }))

const privateUpsertTaskTemplateAPI = authorizedAPI
  .route({
    method: "POST",
    path: "/workspaces/{workspaceId}/pipelines/{pipelineId}/stages/{stageId}/task-templates",
    summary: "Create or update a stage task template",
    tags: ["Pipelines"],
  })
  .input(
    upsertDealTaskTemplateRequest
      .and(withStage)
      .and(z.object({ templateId: zodBigintAsString().nullish() })),
  )
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(dealTaskTemplateResource)
  .handler(async ({ input, context }) => {
    const { workspaceId, pipelineId, stageId, templateId, ...data } = input
    return await dealTaskTemplateService.upsert({
      workspaceId,
      pipelineId,
      stageId,
      templateId,
      data,
      viewer: viewerFromContext(context),
    })
  })

const privateRemoveTaskTemplateAPI = authorizedAPI
  .route({
    method: "DELETE",
    path: "/workspaces/{workspaceId}/pipelines/{pipelineId}/stages/{stageId}/task-templates/{templateId}",
    summary: "Delete a stage task template",
    tags: ["Pipelines"],
  })
  .input(withStage.and(z.object({ templateId: zodBigintAsString() })))
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(z.object({ deleted: z.literal(true) }))
  .handler(async ({ input, context }) => {
    await dealTaskTemplateService.remove({
      ...input,
      viewer: viewerFromContext(context),
    })
    return { deleted: true as const }
  })

const withTemplateId = withStage.and(
  z.object({ templateId: zodBigintAsString() }),
)

const privateAddTaskTemplateDependencyAPI = authorizedAPI
  .route({
    method: "POST",
    path: "/workspaces/{workspaceId}/pipelines/{pipelineId}/stages/{stageId}/task-templates/{templateId}/dependencies",
    summary: "Make a task template wait on another template of the stage",
    tags: ["Pipelines"],
  })
  .input(addTaskTemplateDependencyRequest.and(withTemplateId))
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(z.object({ templateId: z.string(), dependsOnTemplateId: z.string() }))
  .handler(async ({ input, context }) => {
    const row = await dealTaskTemplateService.addDependency({
      ...input,
      viewer: viewerFromContext(context),
    })
    return {
      templateId: row.templateId,
      dependsOnTemplateId: row.dependsOnTemplateId,
    }
  })

const privateRemoveTaskTemplateDependencyAPI = authorizedAPI
  .route({
    method: "DELETE",
    path: "/workspaces/{workspaceId}/pipelines/{pipelineId}/stages/{stageId}/task-templates/{templateId}/dependencies/{dependsOnTemplateId}",
    summary: "Remove a task template dependency",
    tags: ["Pipelines"],
  })
  .input(
    withTemplateId.and(z.object({ dependsOnTemplateId: zodBigintAsString() })),
  )
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(z.object({ removed: z.boolean() }))
  .handler(
    async ({ input, context }) =>
      await dealTaskTemplateService.removeDependency({
        ...input,
        viewer: viewerFromContext(context),
      }),
  )

export const privateDealTasksAPI = {
  privateListDealTasksAPI,
  privateCreateDealTaskAPI,
  privateUpdateDealTaskAPI,
  privateCompleteDealTaskAPI,
  privateReopenDealTaskAPI,
  privateDeleteDealTaskAPI,
  privateAddDealDependencyAPI,
  privateRemoveDealDependencyAPI,
  privateListPipelineTaskTemplatesAPI,
  privateUpsertTaskTemplateAPI,
  privateAddTaskTemplateDependencyAPI,
  privateRemoveTaskTemplateDependencyAPI,
  privateRemoveTaskTemplateAPI,
}
