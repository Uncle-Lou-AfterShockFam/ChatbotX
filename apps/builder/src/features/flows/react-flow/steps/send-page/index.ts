import {
  type SendPageStepSchema,
  sendPageStepDefaultFn,
  sendPageStepSchema,
} from "@chatbotx.io/flow-config"
import type { StepDefinition } from "../definition"
import SendPageStepEditor from "./editor"
import SendPageStepViewer from "./viewer"

export const sendPageStep: StepDefinition<SendPageStepSchema> = {
  editor: SendPageStepEditor,
  viewer: SendPageStepViewer,
  validator: sendPageStepSchema,
  defaultFn: sendPageStepDefaultFn,
}
