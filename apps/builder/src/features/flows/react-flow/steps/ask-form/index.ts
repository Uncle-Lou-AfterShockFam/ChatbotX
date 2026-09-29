import {
  type AskFormStepSchema,
  askFormStepDefaultFn,
  askFormStepSchema,
} from "@chatbotx.io/flow-config"
import type { StepDefinition } from "../definition"
import { AskFormStepEditor } from "./editor"
import { AskFormStepViewer } from "./viewer"

export const askFormStep: StepDefinition<AskFormStepSchema> = {
  editor: AskFormStepEditor,
  viewer: AskFormStepViewer,
  validator: askFormStepSchema,
  defaultFn: askFormStepDefaultFn,
}
