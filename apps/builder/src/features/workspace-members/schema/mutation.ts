import {
  workspaceMemberNotificationChannelsSchema,
  workspaceMemberNotificationTypesSchema,
} from "@chatbotx.io/database/partials"
import { z } from "zod"

export const inviteWorkspaceMemberRequest = z.object({
  permissions: z
    .object({
      superAdmin: z.boolean(),
      analytics: z.boolean(),
      flows: z.boolean(),
      contacts: z.boolean(),
      onlyAssignedContacts: z.boolean(),
      emailAndPhone: z.boolean(),
      broadcast: z.boolean(),
      ecommerce: z.boolean(),
    })
    .refine((val) => Object.values(val).some(Boolean), {
      message: "At least one permission must be selected.",
      path: ["permissions"],
    }),
})
export type InviteWorkspaceMemberRequest = z.infer<
  typeof inviteWorkspaceMemberRequest
>

// The mutation is the FULL shape (every switch is on the form); the stored
// schemas keep the s194 keys optional for legacy rows.
export const updateWorkspaceMemberRequest = inviteWorkspaceMemberRequest.extend(
  {
    notificationTypes: workspaceMemberNotificationTypesSchema.required(),
    notificationChannels: workspaceMemberNotificationChannelsSchema.required(),
  },
)
export type UpdateWorkspaceMemberRequest = z.infer<
  typeof updateWorkspaceMemberRequest
>
