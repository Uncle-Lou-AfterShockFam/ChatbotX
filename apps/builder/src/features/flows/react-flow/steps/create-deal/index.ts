import {
  type CreateDealStepSchema,
  createDealStepDefaultFn,
  createDealStepSchema,
} from "@chatbotx.io/flow-config"
import type { StepDefinition } from "../definition"
import CreateDealStepEditor from "./editor"
import CreateDealStepViewer from "./viewer"

export const createDealStep: StepDefinition<CreateDealStepSchema> = {
  editor: CreateDealStepEditor,
  viewer: CreateDealStepViewer,
  validator: createDealStepSchema,
  defaultFn: createDealStepDefaultFn,
}
