import {
  type CreateTaskStepSchema,
  createTaskStepDefaultFn,
  createTaskStepSchema,
} from "@chatbotx.io/flow-config"
import type { StepDefinition } from "../definition"
import CreateTaskStepEditor from "./editor"
import CreateTaskStepViewer from "./viewer"

export const createTaskStep: StepDefinition<CreateTaskStepSchema> = {
  editor: CreateTaskStepEditor,
  viewer: CreateTaskStepViewer,
  validator: createTaskStepSchema,
  defaultFn: createTaskStepDefaultFn,
}
