"use client"

import {
  FORM_MAX_ACTIONS,
  type FormAction,
} from "@chatbotx.io/database/partials"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import { Checkbox } from "@chatbotx.io/ui/components/ui/checkbox"
import { Input } from "@chatbotx.io/ui/components/ui/input"
import { Label } from "@chatbotx.io/ui/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@chatbotx.io/ui/components/ui/select"
import { Trash2Icon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useCustomFieldStore } from "@/features/custom-fields/provider/custom-field-store-context"
import { useOwnerOptions } from "@/features/deals/provider/deal-hook"

const ACTION_TYPES = [
  "addPoints",
  "setField",
  "removeTags",
  "notifyUsers",
] as const satisfies readonly FormAction["type"][]

const TAG_SEPARATOR = /[\n,]+/

/** A fresh action of `type`; an empty id refuses the save until one is picked. */
const blankAction = (type: FormAction["type"]): FormAction => {
  switch (type) {
    case "addPoints":
      return { type, customFieldId: "" }
    case "setField":
      return { type, customFieldId: "", value: "" }
    case "removeTags":
      return { type, names: [] }
    default:
      return { type: "notifyUsers", userIds: [] }
  }
}

/**
 * The form's action catalogue (s220 A2-3): what every submission does after
 * it is written, web and chat alike. The server checks each reference on
 * save (a points field must be a number field; users must be members).
 */
export function FormActionsEditor(props: {
  workspaceId: string
  actions: FormAction[]
  onChange: (actions: FormAction[]) => void
}) {
  const t = useTranslations()
  const customFields = useCustomFieldStore((s) => s.customFields)
  const members = useOwnerOptions(props.workspaceId)
  const { actions, onChange } = props
  const replace = (index: number, next: FormAction) =>
    onChange(actions.map((a, i) => (i === index ? next : a)))

  const fieldSelect = (
    index: number,
    value: string,
    numbersOnly: boolean,
    apply: (customFieldId: string) => FormAction,
  ) => (
    <Select
      onValueChange={(v) => replace(index, apply(String(v ?? "")))}
      value={value || undefined}
    >
      <SelectTrigger aria-label={t("forms.submitActions.field")}>
        <SelectValue placeholder={t("forms.submitActions.field")} />
      </SelectTrigger>
      <SelectContent>
        {customFields
          .filter((cf) => !numbersOnly || cf.type === "number")
          .map((cf) => (
            <SelectItem key={cf.id} value={cf.id}>
              {cf.name}
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  )

  return (
    <div className="space-y-3" data-testid="form-actions-editor">
      <div className="space-y-1">
        <Label>{t("forms.submitActions.title")}</Label>
        <p className="text-muted-foreground text-xs">
          {t("forms.submitActions.hint")}
        </p>
      </div>
      {actions.map((action, index) => (
        <div
          className="space-y-2 rounded-md border p-3"
          // biome-ignore lint/suspicious/noArrayIndexKey: actions have no id; order is the identity
          key={index}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-sm">
              {t(`forms.submitActions.types.${action.type}`)}
            </span>
            <Button
              aria-label={t("forms.submitActions.remove")}
              onClick={() => onChange(actions.filter((_, i) => i !== index))}
              size="icon"
              type="button"
              variant="ghost"
            >
              <Trash2Icon className="size-4" />
            </Button>
          </div>
          {action.type === "addPoints" &&
            fieldSelect(index, action.customFieldId, true, (customFieldId) => ({
              ...action,
              customFieldId,
            }))}
          {action.type === "setField" && (
            <>
              {fieldSelect(
                index,
                action.customFieldId,
                false,
                (customFieldId) => ({
                  ...action,
                  customFieldId,
                }),
              )}
              <Input
                aria-label={t("forms.submitActions.value")}
                maxLength={500}
                onChange={(e) =>
                  replace(index, { ...action, value: e.target.value })
                }
                placeholder={t("forms.submitActions.value")}
                value={action.value}
              />
            </>
          )}
          {action.type === "removeTags" && (
            <Input
              aria-label={t("forms.submitActions.tags")}
              onChange={(e) =>
                replace(index, {
                  ...action,
                  names: e.target.value
                    .split(TAG_SEPARATOR)
                    .map((n) => n.trim())
                    .filter(Boolean),
                })
              }
              placeholder={t("forms.submitActions.tags")}
              value={action.names.join(", ")}
            />
          )}
          {action.type === "notifyUsers" && (
            <ul className="max-h-48 space-y-1 overflow-y-auto">
              {members.map((m) => {
                const checked = action.userIds.includes(m.value)
                return (
                  <li className="flex items-center gap-2" key={m.value}>
                    <Checkbox
                      checked={checked}
                      id={`fa-${index}-${m.value}`}
                      onCheckedChange={(on) =>
                        replace(index, {
                          ...action,
                          userIds: on
                            ? [...action.userIds, m.value]
                            : action.userIds.filter((id) => id !== m.value),
                        })
                      }
                    />
                    <Label
                      className="font-normal"
                      htmlFor={`fa-${index}-${m.value}`}
                    >
                      {m.label}
                    </Label>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      ))}
      {actions.length < FORM_MAX_ACTIONS && (
        <Select
          onValueChange={(type) =>
            onChange([...actions, blankAction(type as FormAction["type"])])
          }
          value=""
        >
          <SelectTrigger aria-label={t("forms.submitActions.add")}>
            <SelectValue placeholder={t("forms.submitActions.add")} />
          </SelectTrigger>
          <SelectContent>
            {ACTION_TYPES.map((type) => (
              <SelectItem key={type} value={type}>
                {t(`forms.submitActions.types.${type}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  )
}
