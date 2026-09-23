"use client"

import { InputField } from "@chatbotx.io/ui/components/form/input-field"
import { SwitchField } from "@chatbotx.io/ui/components/form/switch-field"
import { TextareaField } from "@chatbotx.io/ui/components/form/textarea-field"
import { useTranslations } from "next-intl"

/**
 * The create and update dialogs share one field set. `domains` is edited as
 * one comma-separated text input (`domainsText`) and split by the caller.
 */
export function CompanyFormFields() {
  const t = useTranslations()
  return (
    <>
      <InputField label={t("fields.name.label")} name="name" required />
      <InputField
        description={t("companies.fields.domainsHint")}
        label={t("companies.fields.domains")}
        name="domainsText"
        placeholder="acme.com, acme.co"
      />
      <InputField label={t("companies.fields.website")} name="website" />
      <InputField label={t("companies.fields.phone")} name="phone" />
      <TextareaField label={t("companies.fields.notes")} name="notes" />
      <SwitchField
        description={t("companies.stopOnReplyDescription")}
        label={t("companies.stopOnReply")}
        name="stopOnReply"
      />
    </>
  )
}

const DOMAIN_SEPARATOR = /[,\s]+/

export const splitDomains = (text: string | null | undefined): string[] =>
  (text ?? "")
    .split(DOMAIN_SEPARATOR)
    .map((domain) => domain.trim())
    .filter((domain) => domain.length > 0)
