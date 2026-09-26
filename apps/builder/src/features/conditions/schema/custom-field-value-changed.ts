import {
  operatorTypes,
  triggerEventTypes,
} from "@chatbotx.io/database/partials"
import { MAX_CUSTOM_FIELD_OPTIONS } from "@chatbotx.io/utils/custom-field"
import z from "zod"

/**
 * s203: an option-field list value, `{ options: [...] }`. The field type is not
 * known here (only its id), so the operator / shape pairing is checked by the
 * evaluator, which fails closed; this only refuses a malformed list.
 */
const optionListValue = z.object({
  options: z
    .array(z.string().trim().min(1))
    .min(1)
    .max(MAX_CUSTOM_FIELD_OPTIONS),
})

export const customFieldValueChanged = z.object({
  id: z.string().optional(),
  type: z.literal(triggerEventTypes.enum.customFieldValueChanged),
  sourceId: z.string().min(1, "Custom field is required"),
  operator: z.string(),
  value: z.unknown().superRefine((value, ctx) => {
    if (
      value !== null &&
      typeof value === "object" &&
      "options" in value &&
      !optionListValue.safeParse(value).success
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Pick at least one option",
      })
    }
  }),
})
export type CustomFieldValueChanged = z.infer<typeof customFieldValueChanged>

export const defaultFn = (): CustomFieldValueChanged => ({
  type: triggerEventTypes.enum.customFieldValueChanged,
  sourceId: "",
  operator: operatorTypes.enum.eq,
  value: "",
})
