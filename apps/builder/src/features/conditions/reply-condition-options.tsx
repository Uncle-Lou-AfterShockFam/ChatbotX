import { triggerEventTypes } from "@chatbotx.io/database/partials"
import type { useTranslations } from "next-intl"
import { createDefaultFnWithSourceId } from "./schema/simple-conditions"

type Translate = ReturnType<typeof useTranslations>

/** The "Replies" option group of the trigger and webhook menus (s228b). */
export const replyConditionOptionGroup = (t: Translate) => ({
  label: t("replyClassification.title"),
  children: [
    {
      label: t("trigger.conditions.contactReplyClassified"),
      value: triggerEventTypes.enum.contactReplyClassified,
      defaultFn: createDefaultFnWithSourceId(
        triggerEventTypes.enum.contactReplyClassified,
      ),
    },
  ],
})
