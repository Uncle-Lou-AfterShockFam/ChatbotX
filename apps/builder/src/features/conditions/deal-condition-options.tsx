import { triggerEventTypes } from "@chatbotx.io/database/partials"
import type { useTranslations } from "next-intl"
import { DEAL_CONDITION_TYPES } from "./schema/deal-conditions"
import { createDefaultFnWithSourceId } from "./schema/simple-conditions"

type Translate = ReturnType<typeof useTranslations>

/**
 * The "Pipelines" option group shared by the trigger and the webhook
 * add-condition menus: one entry per deal (`ticket*`) event, each defaulting
 * to a condition that carries a sourceId (the worker matches it exactly).
 * Adding a deal event to DEAL_CONDITION_TYPES lands in both menus at once.
 */
export const dealConditionOptionGroup = (t: Translate) => ({
  label: t("fields.pipelines.label"),
  children: DEAL_CONDITION_TYPES.map((type) => ({
    label: t(`trigger.conditions.${type}`),
    value: triggerEventTypes.enum[type],
    defaultFn: createDefaultFnWithSourceId(triggerEventTypes.enum[type]),
  })),
})
