import {
  type SetDealStatusStepSchema,
  setDealStatusStepDefaultFn,
  setDealStatusStepSchema,
} from "@chatbotx.io/flow-config"
import type { StepDefinition } from "../definition"
import SetDealStatusStepEditor from "./editor"
import SetDealStatusStepViewer from "./viewer"

export const setDealStatusStep: StepDefinition<SetDealStatusStepSchema> = {
  editor: SetDealStatusStepEditor,
  viewer: SetDealStatusStepViewer,
  validator: setDealStatusStepSchema,
  defaultFn: setDealStatusStepDefaultFn,
}
