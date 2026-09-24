import {
  type CompleteTaskStepSchema,
  completeTaskStepDefaultFn,
  completeTaskStepSchema,
} from "@chatbotx.io/flow-config"
import type { StepDefinition } from "../definition"
import CompleteTaskStepEditor from "./editor"
import CompleteTaskStepViewer from "./viewer"

export const completeTaskStep: StepDefinition<CompleteTaskStepSchema> = {
  editor: CompleteTaskStepEditor,
  viewer: CompleteTaskStepViewer,
  validator: completeTaskStepSchema,
  defaultFn: completeTaskStepDefaultFn,
}
