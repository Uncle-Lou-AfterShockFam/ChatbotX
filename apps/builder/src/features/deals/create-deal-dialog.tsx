"use client"

import type { DealFieldDef } from "@chatbotx.io/database/partials"
import { ComboboxField } from "@chatbotx.io/ui/components/form/combobox-field"
import { InputField } from "@chatbotx.io/ui/components/form/input-field"
import { SelectField } from "@chatbotx.io/ui/components/form/select-field"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@chatbotx.io/ui/components/ui/dialog"
import { Form } from "@chatbotx.io/ui/components/ui/form"
import { Input } from "@chatbotx.io/ui/components/ui/input"
import { zodResolver } from "@hookform/resolvers/zod"
import { Loader2Icon, PlusIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useAction } from "next-safe-action/hooks"
import { useCallback, useMemo, useState } from "react"
import { useForm } from "react-hook-form"
import { toast } from "sonner"
import z from "zod"
import { createDealAction } from "./actions/create-deal-action"
import { DealCustomFieldsGrid } from "./deal-field-input"
import { useContactSearchOptions, useOwnerOptions } from "./provider/deal-hook"

const formSchema = z.object({
  title: z.string().trim().min(1).max(200),
  value: z.string().trim().max(32),
  currency: z.string().trim().max(3),
  priority: z.enum(["low", "medium", "high"]),
  stageId: z.string(),
  contactId: z.string(),
  ownerId: z.string(),
  /** yyyy-mm-dd or empty. */
  dueAt: z.string(),
})
type FormValues = z.infer<typeof formSchema>

export function CreateDealDialog({
  workspaceId,
  pipelineId,
  stages,
  defaultCurrency,
  fieldDefs = [],
  onCreated,
  defaultStageId,
  presetContact,
  presetCompanyId,
}: {
  workspaceId: string
  pipelineId: string
  stages: { id: string; name: string }[]
  defaultCurrency: string
  fieldDefs?: DealFieldDef[]
  onCreated: () => void
  defaultStageId?: string
  /** s195: opened from a contact page, the contact is fixed (no search shown). */
  presetContact?: { id: string; label: string } | null
  /** s195: opened from a company page, the deal lands on that company. */
  presetCompanyId?: string | null
}) {
  const t = useTranslations()
  const [open, setOpen] = useState(false)
  const [contactKeyword, setContactKeyword] = useState("")
  const [fields, setFields] = useState<Record<string, unknown>>({})
  const defaults = useMemo<FormValues>(
    () => ({
      title: "",
      value: "",
      currency: defaultCurrency,
      priority: "medium",
      stageId: defaultStageId ?? stages[0]?.id ?? "",
      contactId: presetContact?.id ?? "",
      ownerId: "",
      dueAt: "",
    }),
    [defaultCurrency, defaultStageId, stages, presetContact?.id],
  )
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    mode: "onChange",
    defaultValues: defaults,
  })
  const contactOptions = useContactSearchOptions(workspaceId, contactKeyword, {
    enabled: open,
  })
  const ownerOptions = useOwnerOptions(workspaceId, { enabled: open })

  const { execute, isPending } = useAction(
    createDealAction.bind(null, workspaceId),
    {
      onSuccess: () => {
        toast.success(t("messages.createdSuccess", { feature: t("deals.one") }))
        setOpen(false)
        form.reset(defaults)
        setFields({})
        onCreated()
      },
      onError: ({ error }) => {
        if (error.serverError) {
          toast.error(error.serverError)
        }
      },
    },
  )

  const handleOpenChange = useCallback(
    (isOpen: boolean) => {
      setOpen(isOpen)
      if (!isOpen) {
        form.reset(defaults)
        setContactKeyword("")
        setFields({})
      }
    },
    [form, defaults],
  )

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogTrigger
        render={
          <Button data-testid="create-deal" size="sm">
            <PlusIcon />
            {t("messages.createFeature", { feature: t("deals.one") })}
          </Button>
        }
      />
      <DialogContent className="max-h-screen max-w-xl overflow-y-scroll">
        <DialogHeader>
          <DialogTitle>
            {t("messages.createFeature", { feature: t("deals.one") })}
          </DialogTitle>
          <DialogDescription />
        </DialogHeader>
        <Form {...form}>
          <form
            className="space-y-5"
            onSubmit={form.handleSubmit((values) =>
              execute({
                pipelineId,
                stageId: values.stageId || null,
                title: values.title,
                value: values.value || null,
                currency: values.currency || null,
                priority: values.priority,
                contactId: values.contactId || null,
                companyId: presetCompanyId ?? undefined,
                ownerId: values.ownerId || null,
                dueAt: values.dueAt
                  ? new Date(`${values.dueAt}T00:00:00Z`)
                  : null,
                fields,
              }),
            )}
          >
            <InputField label={t("deals.fields.title")} name="title" required />
            <div className="grid grid-cols-2 gap-3">
              <InputField
                label={t("deals.fields.value")}
                name="value"
                placeholder="1500"
              />
              <InputField
                label={t("deals.fields.currency")}
                name="currency"
                placeholder="USD"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <SelectField
                label={t("deals.stage")}
                name="stageId"
                options={stages.map((s) => ({ label: s.name, value: s.id }))}
              />
              <SelectField
                label={t("deals.fields.priority")}
                name="priority"
                options={[
                  { label: t("deals.priorities.low"), value: "low" },
                  { label: t("deals.priorities.medium"), value: "medium" },
                  { label: t("deals.priorities.high"), value: "high" },
                ]}
              />
            </div>
            {presetContact ? (
              <div className="space-y-1 text-sm">
                <div className="text-muted-foreground text-xs">
                  {t("deals.fields.contact")}
                </div>
                <div data-testid="create-deal-preset-contact">
                  {presetContact.label}
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <Input
                  aria-label={t("deals.searchContacts")}
                  onChange={(event) => setContactKeyword(event.target.value)}
                  placeholder={t("deals.searchContacts")}
                  value={contactKeyword}
                />
                <ComboboxField
                  allowClear
                  clearLabel={t("deals.noContact")}
                  emptyText={t("actions.noRecordFound")}
                  label={t("deals.fields.contact")}
                  name="contactId"
                  options={contactOptions}
                  portal
                />
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <ComboboxField
                allowClear
                clearLabel={t("deals.noOwner")}
                emptyText={t("actions.noRecordFound")}
                label={t("deals.fields.owner")}
                name="ownerId"
                options={ownerOptions}
                portal
              />
              <InputField
                label={t("deals.fields.dueAt")}
                name="dueAt"
                type="date"
              />
            </div>
            <DealCustomFieldsGrid
              fieldDefs={fieldDefs}
              onCommit={(key, next) =>
                setFields((prev) => ({ ...prev, [key]: next }))
              }
              testIdPrefix="create-deal-field"
              values={fields}
            />
            <DialogFooter>
              <DialogClose
                render={
                  <Button size="sm" type="button" variant="ghost">
                    {t("actions.cancel")}
                  </Button>
                }
              />
              <Button
                disabled={!form.formState.isValid || isPending}
                size="sm"
                type="submit"
              >
                {isPending && <Loader2Icon className="animate-spin" />}
                {t("actions.confirm")}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
