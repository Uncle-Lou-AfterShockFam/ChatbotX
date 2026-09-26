"use server"

import { integrationStripeService } from "@chatbotx.io/business/integration-stripe"
import { createDisconnectAction } from "@/lib/integration-actions"

export const disconnectStripeAction = createDisconnectAction(
  integrationStripeService,
  { name: "Stripe" },
)
