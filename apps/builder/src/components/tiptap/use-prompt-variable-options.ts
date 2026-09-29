import type { ChannelType } from "@chatbotx.io/database/partials"
import { formatBotFieldReference } from "@chatbotx.io/flow-config"
import { useTranslations } from "next-intl"
import { useEffect, useMemo } from "react"
import { useCouponTopicOptions } from "@/features/coupons/provider/use-coupon-topic-options"
import { useCustomFieldSelectOptions } from "@/features/custom-fields/provider/custom-field-hook"
import { useCustomFieldStore } from "@/features/custom-fields/provider/custom-field-store-context"
import { useForms } from "@/features/forms/provider/form-hooks"
import { useWorkspaceId } from "@/hooks/routing"
import type { PromptVariableOption } from "./extensions/variable-injection/definition"

type UsePromptVariableOptionsProps = {
  /** Restricts a credential field to workspace Account Fields only. */
  botFieldsOnly?: boolean
  channels?: ChannelType[]
  includeCouponVariables?: boolean
  includeRawCustomFieldVariables?: boolean
  /**
   * Adds the Account Fields (bot fields) group, inserted as
   * `{{bot_field:<id>}}` tokens. Separate from
   * `includeRawCustomFieldVariables` so a surface (e.g. Send Message) can
   * offer bot fields without also exposing the "raw" custom-field group.
   */
  includeBotFieldVariables?: boolean
  /**
   * s220c A2-4: `{{form_link:<formId>}}`, the contact's personal link to a
   * published form, minted at send time. Defaults to on wherever coupon
   * variables are (both are per-contact, send-time variables).
   */
  includeFormLinkVariables?: boolean
}

/** Pure: published forms as `{{form_link:<id>}}` options (s220c A2-4). */
export const buildFormLinkPromptVariableOptions = (
  forms: { id: string; title: string; status: string }[],
  group: string,
): PromptVariableOption[] =>
  forms
    .filter((form) => form.status === "published")
    .map((form) => ({
      group,
      label: form.title,
      value: `form_link:${form.id}`,
    }))

/**
 * Pure so it is unit-testable without mounting the hook / store. Bot fields
 * are workspace-level (Account Fields), so unlike contact custom fields they
 * are inserted by id — `formatBotFieldReference(id)` — never by name, to
 * avoid colliding with a contact custom field of the same name.
 */
export const buildBotFieldPromptVariableOptions = (
  botFields: { id: string; name: string }[],
  group: string,
): PromptVariableOption[] =>
  botFields.map((field) => ({
    label: field.name,
    value: formatBotFieldReference(field.id),
    group,
  }))

export function usePromptVariableOptions({
  botFieldsOnly = false,
  channels,
  includeCouponVariables = false,
  includeRawCustomFieldVariables = false,
  includeBotFieldVariables = false,
  includeFormLinkVariables = includeCouponVariables,
}: UsePromptVariableOptionsProps): PromptVariableOption[] {
  const t = useTranslations()
  const workspaceId = useWorkspaceId()
  const forms = useForms(workspaceId, false, {
    enabled: includeFormLinkVariables && !botFieldsOnly && Boolean(workspaceId),
  })
  const formLinkOptions = useMemo(
    () =>
      includeFormLinkVariables && !botFieldsOnly
        ? buildFormLinkPromptVariableOptions(
            forms.data ?? [],
            t("forms.variables.group"),
          )
        : [],
    [botFieldsOnly, forms.data, includeFormLinkVariables, t],
  )
  const customFieldSelectOptions = useCustomFieldSelectOptions({
    includeReserved: true,
    customFieldValueKey: "name",
    channels,
  })
  const rawCustomFieldSelectOptions = useCustomFieldSelectOptions({
    customFieldValueKey: "name",
    prefix: "raw",
    channels,
  })
  const rawCustomFieldOptions = useMemo(
    () =>
      includeRawCustomFieldVariables && !botFieldsOnly
        ? rawCustomFieldSelectOptions.map((option) => ({
            ...option,
            group: t("customFields.variables.rawGroup"),
          }))
        : [],
    [
      botFieldsOnly,
      includeRawCustomFieldVariables,
      rawCustomFieldSelectOptions,
      t,
    ],
  )
  const { botFields, ensureBotFieldsLoaded } = useCustomFieldStore(
    (state) => state,
  )
  useEffect(() => {
    if (includeBotFieldVariables) {
      ensureBotFieldsLoaded()
    }
  }, [includeBotFieldVariables, ensureBotFieldsLoaded])
  const botFieldOptions = useMemo(
    () =>
      includeBotFieldVariables
        ? buildBotFieldPromptVariableOptions(
            botFields,
            t("fields.customField.groupAccountFields"),
          )
        : [],
    [includeBotFieldVariables, botFields, t],
  )
  const { topics } = useCouponTopicOptions({
    enabled: includeCouponVariables && !botFieldsOnly,
  })
  const couponOptions = useMemo(
    () =>
      topics.map((topic) => ({
        group: t("coupons.variables.group"),
        label: topic.name,
        value: `coupon:${topic.id}`,
      })),
    [t, topics],
  )

  return useMemo(
    () =>
      botFieldsOnly
        ? botFieldOptions
        : [
            ...customFieldSelectOptions,
            ...rawCustomFieldOptions,
            ...botFieldOptions,
            ...couponOptions,
            ...formLinkOptions,
          ],
    [
      botFieldsOnly,
      couponOptions,
      customFieldSelectOptions,
      rawCustomFieldOptions,
      botFieldOptions,
      formLinkOptions,
    ],
  )
}
