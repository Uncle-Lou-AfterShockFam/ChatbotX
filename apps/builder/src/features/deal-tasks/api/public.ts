import {
  dealTaskService,
  dealTaskTemplateService,
} from "@chatbotx.io/business/deal-task"
import { z } from "zod"
import {
  possibleErrorsOnCreatingResource,
  possibleErrorsOnDeletingResource,
  possibleErrorsOnFindingResource,
  possibleErrorsOnMutatingResource,
} from "@/lib/orpc/orpc-error-helper"
import { workspaceTokenAuthAPIForScope } from "@/orpc"
import {
  addDealDependencyRequest,
  completeDealTaskRequest,
  createDealTaskRequest,
  updateDealTaskRequest,
  upsertDealTaskTemplateRequest,
} from "../schema/action"
import {
  dealIdParam,
  dealTaskIdParams,
  dealTaskPublicResource,
  dealTaskTemplatePublicResource,
  dealTaskWithBlockersPublicResource,
  dependencyParams,
  stageTemplateParams,
  templateIdParams,
} from "../schema/public"

const workspaceTokenAuthAPI = workspaceTokenAuthAPIForScope("deals")

/** Mounted under `deals` (task routes) and `pipelines` (template routes) in routers/public.ts. */
export const dealTasksPublicRouter = {
  listTasks: workspaceTokenAuthAPI
    .route({
      method: "GET",
      path: "/v1/deals/{id}/tasks",
      summary: "List deal tasks",
      description:
        "Returns every task of a deal, oldest first, each with `blockedBy`: the ids of the still-open tasks it waits on.",
      tags: ["Deals"],
    })
    .input(dealIdParam)
    .output(z.object({ data: z.array(dealTaskWithBlockersPublicResource) }))
    .errors(possibleErrorsOnFindingResource)
    .handler(async ({ context, input }) => ({
      data: await dealTaskService.list({
        workspaceId: context.workspace.id,
        dealId: input.id,
      }),
    })),

  createTask: workspaceTokenAuthAPI
    .route({
      method: "POST",
      path: "/v1/deals/{id}/tasks",
      summary: "Create deal task",
      description:
        "Adds a task to a deal (at most 200 per deal). Emits `taskCreated` for the deal contact, and `taskAssigned` when an assignee is given.",
      successStatus: 201,
      tags: ["Deals"],
    })
    .input(createDealTaskRequest.and(dealIdParam))
    .output(dealTaskPublicResource)
    .errors(possibleErrorsOnCreatingResource)
    .handler(async ({ context, input }) => {
      const { id, ...data } = input
      return await dealTaskService.create({
        workspaceId: context.workspace.id,
        dealId: id,
        data,
      })
    }),

  updateTask: workspaceTokenAuthAPI
    .route({
      method: "PATCH",
      path: "/v1/deals/{id}/tasks/{taskId}",
      summary: "Update deal task",
      description:
        "Changes a task's title, description, assignee or due date. A changed assignee emits `taskAssigned`; a due date moved into the future re-arms the overdue notice.",
      tags: ["Deals"],
    })
    .input(updateDealTaskRequest.and(dealTaskIdParams))
    .output(dealTaskPublicResource)
    .errors(possibleErrorsOnMutatingResource)
    .handler(async ({ context, input }) => {
      const { id, taskId, ...data } = input
      return await dealTaskService.update({
        workspaceId: context.workspace.id,
        dealId: id,
        taskId,
        data,
      })
    }),

  completeTask: workspaceTokenAuthAPI
    .route({
      method: "POST",
      path: "/v1/deals/{id}/tasks/{taskId}/complete",
      summary: "Complete deal task",
      description:
        "Marks a task done and emits `taskCompleted`. Refused with 422 while a task it depends on is still open unless `force` is true; completing an already-done task is a no-op.",
      tags: ["Deals"],
    })
    .input(completeDealTaskRequest.and(dealTaskIdParams))
    .output(z.object({ task: dealTaskPublicResource, completed: z.boolean() }))
    .errors(possibleErrorsOnMutatingResource)
    .handler(
      async ({ context, input }) =>
        await dealTaskService.complete({
          workspaceId: context.workspace.id,
          dealId: input.id,
          taskId: input.taskId,
          force: input.force,
        }),
    ),

  reopenTask: workspaceTokenAuthAPI
    .route({
      method: "POST",
      path: "/v1/deals/{id}/tasks/{taskId}/reopen",
      summary: "Reopen deal task",
      description:
        "Puts a completed task back to open and clears its completion and overdue stamps; no event is emitted.",
      tags: ["Deals"],
    })
    .input(dealTaskIdParams)
    .output(dealTaskPublicResource)
    .errors(possibleErrorsOnMutatingResource)
    .handler(
      async ({ context, input }) =>
        await dealTaskService.reopen({
          workspaceId: context.workspace.id,
          dealId: input.id,
          taskId: input.taskId,
        }),
    ),

  deleteTask: workspaceTokenAuthAPI
    .route({
      method: "DELETE",
      path: "/v1/deals/{id}/tasks/{taskId}",
      summary: "Delete deal task",
      description:
        "Deletes a task and every dependency that references it; tasks that waited on it are no longer blocked by it.",
      successStatus: 204,
      tags: ["Deals"],
    })
    .input(dealTaskIdParams)
    .output(z.void())
    .errors(possibleErrorsOnDeletingResource)
    .handler(async ({ context, input }) => {
      await dealTaskService.remove({
        workspaceId: context.workspace.id,
        dealId: input.id,
        taskId: input.taskId,
      })
    }),

  addDependency: workspaceTokenAuthAPI
    .route({
      method: "POST",
      path: "/v1/deals/{id}/tasks/{taskId}/dependencies",
      summary: "Add task dependency",
      description:
        "Makes the task wait on another task of the same deal. Refused with 422 for a self-dependency, a duplicate, more than 20 dependencies, or a cycle.",
      successStatus: 201,
      tags: ["Deals"],
    })
    .input(addDealDependencyRequest.and(dealTaskIdParams))
    .output(z.object({ taskId: z.string(), dependsOnTaskId: z.string() }))
    .errors(possibleErrorsOnCreatingResource)
    .handler(async ({ context, input }) => {
      const row = await dealTaskService.addDependency({
        workspaceId: context.workspace.id,
        dealId: input.id,
        taskId: input.taskId,
        dependsOnTaskId: input.dependsOnTaskId,
      })
      return { taskId: row.taskId, dependsOnTaskId: row.dependsOnTaskId }
    }),

  removeDependency: workspaceTokenAuthAPI
    .route({
      method: "DELETE",
      path: "/v1/deals/{id}/tasks/{taskId}/dependencies/{dependsOnTaskId}",
      summary: "Remove task dependency",
      description:
        "Removes one dependency edge so the task no longer waits on the other task; removing a missing edge is a no-op.",
      successStatus: 204,
      tags: ["Deals"],
    })
    .input(dependencyParams)
    .output(z.void())
    .errors(possibleErrorsOnDeletingResource)
    .handler(async ({ context, input }) => {
      await dealTaskService.removeDependency({
        workspaceId: context.workspace.id,
        dealId: input.id,
        taskId: input.taskId,
        dependsOnTaskId: input.dependsOnTaskId,
      })
    }),
}

export const dealTaskTemplatesPublicRouter = {
  listTaskTemplates: workspaceTokenAuthAPI
    .route({
      method: "GET",
      path: "/v1/pipelines/{id}/stages/{stageId}/task-templates",
      summary: "List stage task templates",
      description:
        "Returns the task templates of one pipeline stage in order; each one becomes a task when a deal enters the stage.",
      tags: ["Pipelines"],
    })
    .input(stageTemplateParams)
    .output(z.object({ data: z.array(dealTaskTemplatePublicResource) }))
    .errors(possibleErrorsOnFindingResource)
    .handler(async ({ context, input }) => ({
      data: await dealTaskTemplateService.listForStage({
        workspaceId: context.workspace.id,
        pipelineId: input.id,
        stageId: input.stageId,
      }),
    })),

  createTaskTemplate: workspaceTokenAuthAPI
    .route({
      method: "POST",
      path: "/v1/pipelines/{id}/stages/{stageId}/task-templates",
      summary: "Create stage task template",
      description:
        "Adds a task template to a stage (at most 20 per stage). Every deal that later enters the stage gets one task from it, exactly once.",
      successStatus: 201,
      tags: ["Pipelines"],
    })
    .input(upsertDealTaskTemplateRequest.and(stageTemplateParams))
    .output(dealTaskTemplatePublicResource)
    .errors(possibleErrorsOnCreatingResource)
    .handler(async ({ context, input }) => {
      const { id, stageId, ...data } = input
      return await dealTaskTemplateService.upsert({
        workspaceId: context.workspace.id,
        pipelineId: id,
        stageId,
        data,
      })
    }),

  updateTaskTemplate: workspaceTokenAuthAPI
    .route({
      method: "PUT",
      path: "/v1/pipelines/{id}/stages/{stageId}/task-templates/{templateId}",
      summary: "Replace stage task template",
      description:
        "Replaces the whole task template (title, description, due offset and assignment rule); tasks already created from it are untouched.",
      tags: ["Pipelines"],
    })
    .input(upsertDealTaskTemplateRequest.and(templateIdParams))
    .output(dealTaskTemplatePublicResource)
    .errors(possibleErrorsOnMutatingResource)
    .handler(async ({ context, input }) => {
      const { id, stageId, templateId, ...data } = input
      return await dealTaskTemplateService.upsert({
        workspaceId: context.workspace.id,
        pipelineId: id,
        stageId,
        templateId,
        data,
      })
    }),

  deleteTaskTemplate: workspaceTokenAuthAPI
    .route({
      method: "DELETE",
      path: "/v1/pipelines/{id}/stages/{stageId}/task-templates/{templateId}",
      summary: "Delete stage task template",
      description:
        "Deletes a task template; tasks already created from it stay and lose their template link.",
      successStatus: 204,
      tags: ["Pipelines"],
    })
    .input(templateIdParams)
    .output(z.void())
    .errors(possibleErrorsOnDeletingResource)
    .handler(async ({ context, input }) => {
      await dealTaskTemplateService.remove({
        workspaceId: context.workspace.id,
        pipelineId: input.id,
        stageId: input.stageId,
        templateId: input.templateId,
      })
    }),
}
