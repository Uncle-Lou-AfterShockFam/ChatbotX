import {
  type CreateInvoiceStepSchema,
  createInvoiceStepDefaultFn,
  createInvoiceStepSchema,
} from "@chatbotx.io/flow-config"
import type { StepDefinition } from "../definition"
import CreateInvoiceStepEditor from "./editor"
import CreateInvoiceStepViewer from "./viewer"

export const createInvoiceStep: StepDefinition<CreateInvoiceStepSchema> = {
  editor: CreateInvoiceStepEditor,
  viewer: CreateInvoiceStepViewer,
  validator: createInvoiceStepSchema,
  defaultFn: createInvoiceStepDefaultFn,
}
