import {
  createSelectSchema,
  customFieldModel,
} from "@chatbotx.io/database/schema"
import { z } from "zod"

export const customFieldResource = createSelectSchema(customFieldModel, {
  id: z.string(),
  workspaceId: z.string(),
  folderId: z.string().nullable(),
  // nullish: every read that picks columns predating s201 stays valid.
  options: z.array(z.string()).nullish(),
  // type: z.string(),
})
export type CustomFieldResource = z.infer<typeof customFieldResource>

export const publicCustomFieldResource = customFieldResource.pick({
  id: true,
  name: true,
  type: true,
  options: true,
  description: true,
})
