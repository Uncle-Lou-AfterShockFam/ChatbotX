import { zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"

export const createApiRequest = z.object({
  name: z.string().min(1).max(40),
  workspaceId: zodBigintAsString().nullish(),
  callbackUrl: z.url().nullish(),
})
export type CreateApiRequest = z.infer<typeof createApiRequest>

export const apiDeliveryModeValues = ["push", "pull"] as const
export type ApiDeliveryMode = (typeof apiDeliveryModeValues)[number]

export const updateApiRequest = z.object({
  name: z.string().min(1).max(40).optional(),
  callbackUrl: z.url().or(z.literal("")).nullish(),
  /**
   * `push`: outbound messages are POSTed to the callback URL. `pull`: they
   * queue in the API-channel outbox for the worker to lease (a worker with
   * no public URL); the callback URL is ignored.
   */
  deliveryMode: z.enum(apiDeliveryModeValues).optional(),
})
export type UpdateApiRequest = z.infer<typeof updateApiRequest>
