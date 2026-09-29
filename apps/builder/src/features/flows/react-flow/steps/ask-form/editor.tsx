"use client"

import {
  ASK_FORM_MAX_ATTEMPTS,
  ASK_FORM_MAX_TIMEOUT_MINUTES,
  type AskFormStepSchema,
  askFormStepSchema,
} from "@chatbotx.io/flow-config"
import { ComboboxField } from "@chatbotx.io/ui/components/form/combobox-field"
import { InputNumberField } from "@chatbotx.io/ui/components/form/input-number-field"
import { TextareaField } from "@chatbotx.io/ui/components/form/textarea-field"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@chatbotx.io/ui/components/ui/dialog"
import { Form } from "@chatbotx.io/ui/components/ui/form"
import { zodResolver } from "@hookform/resolvers/zod"
import { ClipboardPenLineIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useMemo, useState } from "react"
import type { Resolver, SubmitHandler } from "react-hook-form"
import { useForm, useFormContext } from "react-hook-form"
import { useForms } from "@/features/forms/provider/form-hooks"
import { useWorkspaceId } from "@/hooks/routing"
import { BaseStepEditor } from "../base/editor"

/** The askForm step (s219 A2-2): pick a published chat form, timeout, attempts. */
export function AskFormStepEditor({ parentName }: { parentName: string }) {
  const t = useTranslations()
  const workspaceId = useWorkspaceId()
  const { getValues, setValue } = useFormContext()
  const [open, setOpen] = useState(false)
  const { data: forms = [] } = useForms(workspaceId)
  // Only a published form whose channels include chat can run in a flow.
  const formOptions = useMemo(
    () =>
      forms
        .filter(
          (f) =>
            f.status === "published" && f.settings.channels.includes("chat"),
        )
        .map((f) => ({ label: f.title, value: f.id })),
    [forms],
  )
  const form = useForm<AskFormStepSchema>({
    resolver: zodResolver(askFormStepSchema) as Resolver<AskFormStepSchema>,
    defaultValues: getValues(parentName),
    mode: "onChange",
  })

  const onSubmit: SubmitHandler<AskFormStepSchema> = (values) => {
    setValue(`${parentName}.formId`, values.formId)
    setValue(`${parentName}.timeoutMinutes`, values.timeoutMinutes)
    setValue(`${parentName}.maxAttempts`, values.maxAttempts)
    setValue(`${parentName}.retryMessage`, values.retryMessage)
    setOpen(false)
  }

  return (
    <BaseStepEditor
      icon={ClipboardPenLineIcon}
      title={t("flows.actions.askForm")}
    >
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogTrigger
          render={
            <Button size="sm" type="button" variant="outline">
              {t("actions.edit")}
            </Button>
          }
        />
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("flows.actions.askForm")}</DialogTitle>
            <DialogDescription>
              {t("flows.askForm.description")}
            </DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form
              className="flex flex-col gap-4"
              onSubmit={form.handleSubmit(onSubmit)}
            >
              <ComboboxField
                description={t("flows.askForm.formHint")}
                emptyText={t("flows.askForm.noChatForms")}
                label={t("flows.askForm.form")}
                name="formId"
                options={formOptions}
                placeholder={t("actions.pleaseSelect")}
                required
              />
              <InputNumberField
                description={t("flows.askForm.timeoutHint")}
                label={t("flows.askForm.timeoutMinutes")}
                max={ASK_FORM_MAX_TIMEOUT_MINUTES}
                min={1}
                name="timeoutMinutes"
                required
              />
              <InputNumberField
                description={t("flows.askForm.maxAttemptsHint")}
                label={t("flows.askForm.maxAttempts")}
                max={ASK_FORM_MAX_ATTEMPTS}
                min={1}
                name="maxAttempts"
                required
              />
              <TextareaField
                description={t("flows.askForm.retryHint")}
                label={t("flows.askForm.retryMessage")}
                name="retryMessage"
              />
              <div className="flex justify-end gap-2">
                <Button
                  onClick={() => setOpen(false)}
                  type="button"
                  variant="ghost"
                >
                  {t("actions.cancel")}
                </Button>
                <Button disabled={!form.formState.isValid} type="submit">
                  {t("actions.continue")}
                </Button>
              </div>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </BaseStepEditor>
  )
}
