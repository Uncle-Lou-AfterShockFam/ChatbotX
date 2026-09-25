import {
  type SendDocumentForSignatureStepSchema,
  sendDocumentForSignatureStepDefaultFn,
  sendDocumentForSignatureStepSchema,
} from "@chatbotx.io/flow-config"
import type { StepDefinition } from "../definition"
import SendDocumentForSignatureStepEditor from "./editor"
import SendDocumentForSignatureStepViewer from "./viewer"

export const sendDocumentForSignatureStep: StepDefinition<SendDocumentForSignatureStepSchema> =
  {
    editor: SendDocumentForSignatureStepEditor,
    viewer: SendDocumentForSignatureStepViewer,
    validator: sendDocumentForSignatureStepSchema,
    defaultFn: sendDocumentForSignatureStepDefaultFn,
  }
