"use client"

import { requestedInvoiceMethods } from "@chatbotx.io/database/partials"
import { CREATE_INVOICE_MAX_LINES } from "@chatbotx.io/flow-config"
import { InputField } from "@chatbotx.io/ui/components/form/input-field"
import { InputNumberField } from "@chatbotx.io/ui/components/form/input-number-field"
import { SelectField } from "@chatbotx.io/ui/components/form/select-field"
import { TextareaField } from "@chatbotx.io/ui/components/form/textarea-field"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import { ReceiptTextIcon, XIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useMemo } from "react"
import { useFieldArray, useFormContext } from "react-hook-form"
import { BaseStepEditor } from "../base/editor"

const CreateInvoiceStepEditor = ({ parentName }: { parentName: string }) => {
  const t = useTranslations()
  const { control } = useFormContext()
  const { fields, append, remove } = useFieldArray({
    control,
    name: `${parentName}.lines`,
  })
  const methodOptions = useMemo(
    () =>
      requestedInvoiceMethods.options.map((value) => ({
        value,
        label: t(`invoices.method.${value}`),
      })),
    [t],
  )

  return (
    <BaseStepEditor
      icon={ReceiptTextIcon}
      title={t("flows.actions.createInvoice")}
    >
      <div className="mt-3 space-y-3">
        <p className="text-muted-foreground text-xs">
          {t("invoices.step.hint")}
        </p>
        <div className="space-y-2">
          <p className="font-medium text-sm">{t("invoices.fields.lines")}</p>
          {fields.map((field, index) => (
            <div className="space-y-2 rounded-md border p-2" key={field.id}>
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <InputField
                    name={`${parentName}.lines.${index}.description`}
                    placeholder={t("invoices.fields.description")}
                  />
                </div>
                <Button
                  aria-label={t("actions.remove")}
                  className="shrink-0 text-destructive"
                  disabled={fields.length === 1}
                  onClick={() => remove(index)}
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <XIcon className="h-4 w-4" />
                </Button>
              </div>
              <div className="flex gap-2">
                <div className="w-24 shrink-0">
                  <InputNumberField
                    label={t("invoices.fields.quantity")}
                    min={1}
                    name={`${parentName}.lines.${index}.quantity`}
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <InputField
                    label={t("invoices.fields.unitAmount")}
                    name={`${parentName}.lines.${index}.unitAmount`}
                    placeholder="25.00"
                  />
                </div>
              </div>
            </div>
          ))}
          <Button
            className="w-full"
            disabled={fields.length >= CREATE_INVOICE_MAX_LINES}
            onClick={() =>
              append({ description: "", quantity: 1, unitAmount: "" })
            }
            size="sm"
            type="button"
            variant="outline"
          >
            {t("invoices.addLine")}
          </Button>
        </div>
        <SelectField
          description={t("invoices.step.methodHint")}
          label={t("invoices.fields.method")}
          name={`${parentName}.method`}
          options={methodOptions}
        />
        <InputField
          label={t("invoices.fields.currency")}
          name={`${parentName}.currency`}
          placeholder="USD"
        />
        <InputNumberField
          description={t("invoices.step.dueInDaysHint")}
          label={t("invoices.fields.dueInDays")}
          max={365}
          min={0}
          name={`${parentName}.dueInDays`}
        />
        <TextareaField
          label={t("invoices.fields.memo")}
          name={`${parentName}.memo`}
          placeholder={t("invoices.step.memoPlaceholder")}
        />
      </div>
    </BaseStepEditor>
  )
}

export default CreateInvoiceStepEditor
