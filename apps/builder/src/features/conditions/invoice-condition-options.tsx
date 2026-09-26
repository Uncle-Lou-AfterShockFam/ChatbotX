import { triggerEventTypes } from "@chatbotx.io/database/partials"
import type { useTranslations } from "next-intl"
import { INVOICE_CONDITION_TYPES } from "./schema/invoice-conditions"
import { createDefaultFn } from "./schema/simple-conditions"

type Translate = ReturnType<typeof useTranslations>

/** The "Invoices" option group of the trigger and webhook add-condition menus (s205b). */
export const invoiceConditionOptionGroup = (t: Translate) => ({
  label: t("invoices.title"),
  children: INVOICE_CONDITION_TYPES.map((type) => ({
    label: t(`trigger.conditions.${type}`),
    value: triggerEventTypes.enum[type],
    defaultFn: createDefaultFn(triggerEventTypes.enum[type]),
  })),
})
