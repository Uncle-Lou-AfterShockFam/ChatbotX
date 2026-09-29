"use client"

import type { PageElementSchema } from "@chatbotx.io/flow-config"
import { ComboboxField } from "@chatbotx.io/ui/components/form/combobox-field"
import { SelectField } from "@chatbotx.io/ui/components/form/select-field"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import { Card } from "@chatbotx.io/ui/components/ui/card"
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
import { MoveVerticalIcon, PlusIcon, XIcon } from "lucide-react"
import Link from "next/link"
import { useParams } from "next/navigation"
import { useTranslations } from "next-intl"
import { useCallback, useMemo, useRef } from "react"
import { useFieldArray, useFormContext, useWatch } from "react-hook-form"
import { TiptapEditorField } from "@/components/tiptap/tiptap-editor-field"
import { useEmailTemplates } from "@/features/email-templates/provider/email-template-hooks"
import { useEmailTopicSelectOptions } from "@/features/email-topics/provider/email-topic-hook"
import {
  useInboxOptionsByChannel,
  useSmtpInboxFromAddressMap,
  useSmtpInboxOptions,
} from "@/features/inboxes/provider/inbox-hook"
import { PageElementBuilder } from "../../components/page-element-builder"
import { PAGE_ELEMENTS } from "./page-node-menu"

type EmailStepEditorProps = {
  parentName: string
}

export default function EmailStepEditor(props: EmailStepEditorProps) {
  const { parentName } = props
  const t = useTranslations()
  const params = useParams<{ workspaceId: string; flowId: string }>()
  const smtpInboxOptions = useSmtpInboxOptions()
  const smtpFromAddressMap = useSmtpInboxFromAddressMap()
  const smtpFromAddressMapRef = useRef(smtpFromAddressMap)
  smtpFromAddressMapRef.current = smtpFromAddressMap
  const { control, setValue } = useFormContext()
  const emailTopicOptions = useEmailTopicSelectOptions()
  // B2 phase 4 (s222b): a bulktext email line (an API-channel inbox) sends
  // instead of SMTP; its own address is the sender and the contact's address
  // on the line is the recipient, so From / To / SMTP do not apply.
  const lineOptions = useInboxOptionsByChannel("api")
  const lineInboxId = useWatch({ name: `${parentName}.lineInboxId` })

  const integrationSmtpId = useWatch({
    name: `${parentName}.integrationSmtpId`,
  })
  // B2 phase 3: a saved newsletter template replaces the inline elements
  // (the worker's precedence: templateId, then document, then elements).
  const templateId = useWatch({ name: `${parentName}.templateId` })
  const templates = useEmailTemplates(params.workspaceId ?? "")
  const templateOptions = useMemo(
    () =>
      (templates.data ?? []).map((template) => ({
        label: template.name,
        value: template.id,
      })),
    [templates.data],
  )

  const { fields, append, move, remove } = useFieldArray({
    control,
    name: `${parentName}.elements`,
  })

  const onAddNode = useCallback(
    (defaultFn: () => PageElementSchema) => {
      append(defaultFn())
    },
    [append],
  )

  return (
    <div className="flex flex-col gap-4">
      <div className="relative" data-testid="email-step-line">
        <ComboboxField
          description={t("emailTemplates.step.lineHint")}
          emptyText={t("emailTemplates.step.noLines")}
          label={t("emailTemplates.step.line")}
          name={`${parentName}.lineInboxId`}
          options={lineOptions}
          placeholder={t("emailTemplates.step.lineNone")}
          popoverClassName="w-[var(--anchor-width)]"
        />
        {lineInboxId ? (
          <button
            className="absolute end-0 top-[-2px] text-primary text-sm hover:underline"
            data-testid="email-step-line-clear"
            onClick={() =>
              setValue(`${parentName}.lineInboxId`, undefined, {
                shouldDirty: true,
              })
            }
            type="button"
          >
            {t("emailTemplates.step.clear")}
          </button>
        ) : null}
      </div>

      {lineInboxId ? null : (
        <SelectField
          label={t("fields.smtpChannel.label")}
          name={`${parentName}.integrationSmtpId`}
          options={smtpInboxOptions}
          triggerValueChange={(value) => {
            setValue(
              `${parentName}.from`,
              smtpFromAddressMapRef.current[value ?? ""] ?? "",
            )
          }}
        />
      )}

      <div className="relative">
        <SelectField
          label={t("fields.emailTopic.label")}
          name={`${parentName}.topicId`}
          options={emailTopicOptions}
        />
        <Link
          className="absolute end-0 top-[-2px] text-primary text-sm hover:underline"
          href={`/space/${params.workspaceId}/email-topics`}
        >
          {t("actions.addNew")}
        </Link>
      </div>

      {/* `from` is sent verbatim by the worker (send-email.ts falls back to
      the SMTP integration's own address, never interpolates it) — no bot
      field picker here since a token would never resolve. */}
      {lineInboxId ? null : (
        <>
          <TiptapEditorField
            key={`from-${integrationSmtpId}`}
            label={t("fields.from.label")}
            name={`${parentName}.from`}
            required
          />
          <TiptapEditorField
            includeBotFieldVariables
            label={t("fields.to.label")}
            name={`${parentName}.to`}
            required
          />
        </>
      )}
      <TiptapEditorField
        includeBotFieldVariables
        label={t("fields.subject.label")}
        name={`${parentName}.subject`}
        required
      />
      <TiptapEditorField
        includeBotFieldVariables
        label={t("fields.preheader.label")}
        name={`${parentName}.preheader`}
      />

      <div className="relative" data-testid="email-step-template">
        <ComboboxField
          description={t("emailTemplates.step.hint")}
          emptyText={t("emailTemplates.step.noTemplates")}
          label={t("emailTemplates.step.template")}
          name={`${parentName}.templateId`}
          options={templateOptions}
          placeholder={t("emailTemplates.step.none")}
          popoverClassName="w-[var(--anchor-width)]"
        />
        <div className="absolute end-0 top-[-2px] flex gap-3 text-sm">
          {templateId ? (
            <button
              className="text-primary hover:underline"
              data-testid="email-step-template-clear"
              onClick={() =>
                setValue(`${parentName}.templateId`, undefined, {
                  shouldDirty: true,
                })
              }
              type="button"
            >
              {t("emailTemplates.step.clear")}
            </button>
          ) : null}
          <Link
            className="text-primary hover:underline"
            href={`/space/${params.workspaceId}/settings/email-templates`}
          >
            {t("actions.addNew")}
          </Link>
        </div>
      </div>

      {templateId ? null : (
        <>
          <Card className="px-4">
            <Sortable
              getItemValue={(item) => item.id}
              onMove={({ activeIndex, overIndex }) =>
                move(activeIndex, overIndex)
              }
              value={fields}
            >
              <SortableContent className="flex flex-col gap-2">
                {(fields as PageElementSchema[]).map((field, index) => (
                  <SortableItem
                    key={field.id}
                    render={
                      <div className="flex items-center gap-2">
                        <div className="flex-1">
                          <PageElementBuilder
                            parentName={`${parentName}.elements.${index}`}
                            type={field.type}
                          />
                        </div>
                        <div className="flex flex-col">
                          <Button
                            className="size-8 shrink-0"
                            onClick={() => remove(index)}
                            size="icon"
                            type="button"
                            variant="ghost"
                          >
                            <XIcon aria-hidden="true" className="size-4" />
                          </Button>
                          <SortableItemHandle
                            render={
                              <Button
                                className="size-8"
                                size="icon"
                                variant="ghost"
                              >
                                <MoveVerticalIcon className="h-4 w-4" />
                              </Button>
                            }
                          />
                        </div>
                      </div>
                    }
                    value={field.id}
                  />
                ))}
              </SortableContent>
            </Sortable>
          </Card>

          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button type="button" variant="outline">
                  <PlusIcon />
                  {t("actions.create")}
                </Button>
              }
            />
            <DropdownMenuContent>
              {PAGE_ELEMENTS.map((item) => (
                <DropdownMenuItem
                  key={item.stepType}
                  onClick={() => onAddNode(item.defaultFn)}
                >
                  <item.icon className="size-4" />
                  {t(item.labelKey)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
    </div>
  )
}
