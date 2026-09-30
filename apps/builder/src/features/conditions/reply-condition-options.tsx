import { triggerEventTypes } from "@chatbotx.io/database/partials"
import type { useTranslations } from "next-intl"
import { REPLY_CONDITION_TYPES } from "./schema/reply-conditions"
import { createDefaultFnWithSourceId } from "./schema/simple-conditions"

type Translate = ReturnType<typeof useTranslations>

/** The "Reply" option group of the trigger and webhook menus (s228b). */
export const replyConditionOptionGroup = (t: Translate) => ({
  label: t("replyClassification.title"),
  children: REPLY_CONDITION_TYPES.map((type) => ({
    label: t(`trigger.conditions.${type}`),
    value: triggerEventTypes.enum[type],
    defaultFn: createDefaultFnWithSourceId(triggerEventTypes.enum[type]),
  })),
})
