export { inboxResource } from "@chatbotx.io/business/inbox/schema"

import type {
  InboxModel,
  IntegrationInstagramModel,
  IntegrationMessengerModel,
  IntegrationSmtpModel,
  IntegrationTelegramModel,
  IntegrationWebchatModel,
  IntegrationWhatsappModel,
  IntegrationZaloModel,
} from "@chatbotx.io/database/types"
import type { WithoutCredentials } from "@/lib/without-credentials"

// Client-side inbox rows never carry credentials (s231a): InboxService.list
// does not select them, so the type does not offer them either.
export type InboxResource = InboxModel & {
  integrationWhatsapp?: WithoutCredentials<IntegrationWhatsappModel>
  integrationWebchat?: WithoutCredentials<IntegrationWebchatModel>
  integrationMessenger?: WithoutCredentials<IntegrationMessengerModel>
  integrationInstagram?: WithoutCredentials<IntegrationInstagramModel>
  integrationZalo?: WithoutCredentials<IntegrationZaloModel>
  integrationTelegram?: WithoutCredentials<IntegrationTelegramModel>
  integrationSmtp?: WithoutCredentials<IntegrationSmtpModel>
}
