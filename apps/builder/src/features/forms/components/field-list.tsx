"use client"

import { Button } from "@chatbotx.io/ui/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@chatbotx.io/ui/components/ui/dropdown-menu"
import {
  Sortable,
  SortableContent,
  SortableItem,
  SortableItemHandle,
} from "@chatbotx.io/ui/components/ui/sortable"
import { cn } from "@chatbotx.io/ui/lib/utils"
import type {
  FormDefinition,
  FormStep,
  WebFormFieldType,
} from "@chatbotx.io/utils/form"
import {
  MAX_FORM_FIELDS_PER_STEP,
  webFormFieldTypes,
} from "@chatbotx.io/utils/form"
import { GripVerticalIcon, PlusIcon, Trash2Icon } from "lucide-react"
import { useTranslations } from "next-intl"
import { addField, moveField, newField, removeField } from "../lib/editor-ops"

/** The fields of the selected step: drag to reorder, click to inspect, add by type. */
export function FieldList(props: {
  definition: FormDefinition
  step: FormStep
  selectedKey: string | null
  onSelect: (key: string | null) => void
  onChange: (definition: FormDefinition) => void
}) {
  const { definition, step, selectedKey, onSelect, onChange } = props
  const t = useTranslations()
  const full = step.fields.length >= MAX_FORM_FIELDS_PER_STEP

  return (
    <div className="flex flex-col gap-2" data-testid={`field-list-${step.id}`}>
      <Sortable
        getItemValue={(field) => field.key}
        onMove={({ activeIndex, overIndex }) =>
          onChange(moveField(definition, step.id, activeIndex, overIndex))
        }
        value={step.fields}
      >
        <SortableContent>
          <div className="flex flex-col gap-1">
            {step.fields.map((field) => (
              <SortableItem
                key={field.key}
                render={
                  <div
                    className={cn(
                      "flex items-center gap-2 rounded-md border bg-background p-2",
                      selectedKey === field.key && "border-primary",
                    )}
                    data-testid={`field-row-${field.key}`}
                    role="presentation"
                  >
                    <SortableItemHandle
                      render={
                        <Button
                          aria-label={t("deals.reorder")}
                          size="icon"
                          type="button"
                          variant="ghost"
                        >
                          <GripVerticalIcon className="size-4" />
                        </Button>
                      }
                    />
                    <button
                      className="flex min-w-0 grow flex-col items-start text-start"
                      onClick={() => onSelect(field.key)}
                      type="button"
                    >
                      <span className="truncate text-sm">
                        {field.label || field.key}
                        {field.required ? (
                          <span className="text-destructive"> *</span>
                        ) : null}
                      </span>
                      <span className="text-muted-foreground text-xs">
                        {t(`forms.fieldTypes.${field.type}`)}
                        {field.mapTo ? ` · ${t("forms.editor.mapped")}` : ""}
                        {field.visibleWhen
                          ? ` · ${t("forms.editor.conditional")}`
                          : ""}
                      </span>
                    </button>
                    <Button
                      aria-label={t("actions.delete")}
                      onClick={() => {
                        onChange(removeField(definition, field.key))
                        if (selectedKey === field.key) {
                          onSelect(null)
                        }
                      }}
                      size="icon"
                      type="button"
                      variant="ghost"
                    >
                      <Trash2Icon className="size-4" />
                    </Button>
                  </div>
                }
                value={field.key}
              />
            ))}
          </div>
        </SortableContent>
      </Sortable>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button disabled={full} size="sm" type="button" variant="outline">
              <PlusIcon className="size-4" />
              {t("forms.actions.addField")}
            </Button>
          }
        />
        <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
          {webFormFieldTypes.options.map((type) => (
            <DropdownMenuItem
              data-testid={`add-field-${type}`}
              key={type}
              onClick={() => {
                const field = newField(
                  definition,
                  type as WebFormFieldType,
                  t(`forms.fieldTypes.${type}`),
                )
                onChange(addField(definition, step.id, field))
                onSelect(field.key)
              }}
            >
              {t(`forms.fieldTypes.${type}`)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
