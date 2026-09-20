import {
  type BulktextSendStepSchema,
  bulktextSendStepDefaultFn,
  bulktextSendStepSchema,
} from "@chatbotx.io/flow-config"
import type { StepDefinition } from "../definition"
import BulktextSendStepEditor from "./editor"
import BulktextSendStepViewer from "./viewer"

export const bulktextSendStep: StepDefinition<BulktextSendStepSchema> = {
  editor: BulktextSendStepEditor,
  viewer: BulktextSendStepViewer,
  validator: bulktextSendStepSchema,
  defaultFn: bulktextSendStepDefaultFn,
}
