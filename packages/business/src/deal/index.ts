import { registerDealTaskHooks } from "../deal-task/register"

export * from "./company-stop"
export * from "./service"
export * from "./stage-hooks"

// Task templates instantiate on every stage entry (s192). Registered here so
// every consumer of `@chatbotx.io/business/deal` gets it.
registerDealTaskHooks()
