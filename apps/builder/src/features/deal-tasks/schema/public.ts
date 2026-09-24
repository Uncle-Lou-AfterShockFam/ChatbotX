import { zodBigintAsString } from "@chatbotx.io/utils"
import z from "zod"
import { dealIdParam } from "@/features/deals/schema/public-params"
import {
  dealTaskResource,
  dealTaskTemplateResource,
  dealTaskWithBlockersResource,
} from "./resource"

export const dealTaskPublicResource = dealTaskResource.omit({
  workspaceId: true,
})
export const dealTaskWithBlockersPublicResource =
  dealTaskWithBlockersResource.omit({ workspaceId: true })
export const dealTaskTemplatePublicResource = dealTaskTemplateResource.omit({
  workspaceId: true,
})

export const dealTaskIdParams = dealIdParam.extend({
  taskId: zodBigintAsString().describe(
    "Task id. Get it from `deals.listTasks`.",
  ),
})
export const dependencyParams = dealTaskIdParams.extend({
  dependsOnTaskId: zodBigintAsString().describe(
    "Id of the task this one waits on.",
  ),
})
export const stageTemplateParams = z.object({
  id: zodBigintAsString().describe(
    "Pipeline id. Get it from `pipelines.list`.",
  ),
  stageId: zodBigintAsString().describe("Stage id of that pipeline."),
})
export const templateIdParams = stageTemplateParams.extend({
  templateId: zodBigintAsString().describe(
    "Task template id. Get it from `pipelines.listTaskTemplates`.",
  ),
})

export { dealIdParam } from "@/features/deals/schema/public-params"
