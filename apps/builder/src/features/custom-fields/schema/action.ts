import { customFieldTypes } from "@chatbotx.io/database/partials"
import { zodFieldName } from "@chatbotx.io/flow-config"
import { zodBigintAsString } from "@chatbotx.io/utils"
import {
  customFieldOptionsSchema,
  refineCustomFieldOptions,
} from "@chatbotx.io/utils/custom-field"
import { z } from "zod"

const optionsField = customFieldOptionsSchema.describe(
  "Option labels of a select / multiSelect field (1-100 unique labels, max 60 characters each). Required for those types, refused for every other type.",
)

const createCustomFieldObject = z.object({
  name: zodFieldName().describe(
    "Custom field name, used to reference it in flows.",
  ),
  type: customFieldTypes.describe("Custom field data type."),
  options: optionsField.optional(),
  folderId: zodBigintAsString()
    .nullish()
    .describe("Folder to place the field in, or null for root-level."),
  description: z.string().nullish().describe("Optional internal description."),
})

export const createCustomFieldRequest = createCustomFieldObject.superRefine(
  refineCustomFieldOptions,
)

/** The public API's create body: name, type and (for option types) options. */
export const publicCreateCustomFieldRequest = createCustomFieldObject
  .pick({ name: true, type: true, options: true })
  .superRefine(refineCustomFieldOptions)
export type CreateCustomFieldRequest = z.infer<typeof createCustomFieldRequest>

export const updateCustomFieldRequest = z.object({
  name: zodFieldName().describe("New custom field name."),
  description: z.string().optional().describe("Optional internal description."),
  options: optionsField
    .optional()
    .describe(
      "Replaces the option list of a select / multiSelect field. Values contacts already hold are kept as-is.",
    ),
  folderId: zodBigintAsString()
    .nullish()
    .describe("Folder to place the field in, or null for root-level."),
})
export type UpdateCustomFieldRequest = z.infer<typeof updateCustomFieldRequest>
