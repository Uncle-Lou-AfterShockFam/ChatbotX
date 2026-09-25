import { triggerEventTypes } from "@chatbotx.io/database/partials"
import type { useTranslations } from "next-intl"
import { FORM_CONDITION_TYPES } from "./schema/form-conditions"
import { createDefaultFnWithSourceId } from "./schema/simple-conditions"

type Translate = ReturnType<typeof useTranslations>

/** The "Forms" option group of the trigger and webhook add-condition menus (s200). */
export const formConditionOptionGroup = (t: Translate) => ({
  label: t("forms.title"),
  children: FORM_CONDITION_TYPES.map((type) => ({
    label: t(`trigger.conditions.${type}`),
    value: triggerEventTypes.enum[type],
    defaultFn: createDefaultFnWithSourceId(triggerEventTypes.enum[type]),
  })),
})
