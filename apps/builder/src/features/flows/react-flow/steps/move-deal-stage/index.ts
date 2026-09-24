import {
  type MoveDealStageStepSchema,
  moveDealStageStepDefaultFn,
  moveDealStageStepSchema,
} from "@chatbotx.io/flow-config"
import type { StepDefinition } from "../definition"
import MoveDealStageStepEditor from "./editor"
import MoveDealStageStepViewer from "./viewer"

export const moveDealStageStep: StepDefinition<MoveDealStageStepSchema> = {
  editor: MoveDealStageStepEditor,
  viewer: MoveDealStageStepViewer,
  validator: moveDealStageStepSchema,
  defaultFn: moveDealStageStepDefaultFn,
}
