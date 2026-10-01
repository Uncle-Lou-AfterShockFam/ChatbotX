import { ChatbotXException } from "@chatbotx.io/business/errors"

/** The one refusal for a write that needs the `flows` permission (s233a/s234a). */
export const flowsAccessRequired = () =>
  new ChatbotXException("Flows access required", "flowsAccessRequired", 403)
