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
import { Label } from "@chatbotx.io/ui/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@chatbotx.io/ui/components/ui/select"
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
import { useOmnichannelBroadcastSelectOptions } from "@/features/contact-filter/components/use-workspace-option-sources"
import { headerPreview } from "@/features/email-templates/lib/preview-samples"
import { useEmailTemplates } from "@/features/email-templates/provider/email-template-hooks"
import { useEmailTopicSelectOptions } from "@/features/email-topics/provider/email-topic-hook"
import {
  useInboxOptionsByChannel,
  useSmtpInboxFromAddressMap,
  useSmtpInboxOptions,
} from "@/features/inboxes/provider/inbox-hook"
import { useSequenceOptions } from "@/features/sequences/provider/sequence-hook"
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
  // Outreach B-1 (s225b): plain text reads as a personal note (no pixel,
  // no tracked links) and threads a sequence's steps as one conversation.
  const formatOptions = useMemo(
    () => [
      { label: t("emailTemplates.step.formatHtml"), value: "html" },
      { label: t("emailTemplates.step.formatText"), value: "text" },
    ],
    [t],
  )
  // Outreach B-1 PR 3 (s226b): which earlier mail on this line the step
  // replies under, and what happens when there is none.
  const threadMode = useWatch({ name: `${parentName}.threadMode` })
  const threadModeOptions = useMemo(
    () => [
      { label: t("emailTemplates.step.threadPrevious"), value: "previous" },
      { label: t("emailTemplates.step.threadCampaign"), value: "campaign" },
      { label: t("emailTemplates.step.threadLatest"), value: "latest" },
      { label: t("emailTemplates.step.threadNone"), value: "none" },
    ],
    [t],
  )
  const onNoThreadOptions = useMemo(
    () => [
      { label: t("emailTemplates.step.onNoThreadNew"), value: "new" },
      { label: t("emailTemplates.step.onNoThreadStop"), value: "stop" },
    ],
    [t],
  )
  const threadCampaign = useWatch({ name: `${parentName}.threadCampaign` })
  const sequenceOptions = useSequenceOptions()
  const broadcastOptions = useOmnichannelBroadcastSelectOptions()
  const campaignOptions = useMemo(
    () => [
      ...sequenceOptions.map((sequence) => ({
        value: `sequence:${sequence.id}`,
        label: t("emailTemplates.step.threadCampaignSequence", {
          name: sequence.name,
        }),
      })),
      ...broadcastOptions.map((broadcast) => ({
        value: `broadcast:${broadcast.value}`,
        label: t("emailTemplates.step.threadCampaignBroadcast", {
          name: broadcast.label,
        }),
      })),
    ],
    [sequenceOptions, broadcastOptions, t],
  )
  let campaignValue: string | undefined
  if (threadCampaign?.sequenceId) {
    campaignValue = `sequence:${threadCampaign.sequenceId}`
  } else if (threadCampaign?.broadcastId) {
    campaignValue = `broadcast:${threadCampaign.broadcastId}`
  }
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
            onClick={() => {
              setValue(`${parentName}.lineInboxId`, undefined, {
                shouldDirty: true,
              })
              // s225b/s226b: format and threading exist only on a line.
              for (const field of [
                "format",
                "threadMode",
                "threadCampaign",
                "onNoThread",
              ]) {
                setValue(`${parentName}.${field}`, undefined, {
                  shouldDirty: true,
                })
              }
            }}
            type="button"
          >
            {t("emailTemplates.step.clear")}
          </button>
        ) : null}
      </div>

      {lineInboxId ? (
        <div data-testid="email-step-format">
          <SelectField
            description={t("emailTemplates.step.formatHint")}
            label={t("emailTemplates.step.format")}
            name={`${parentName}.format`}
            options={formatOptions}
            placeholder={t("emailTemplates.step.formatHtml")}
          />
        </div>
      ) : null}

      {lineInboxId ? (
        <div className="flex flex-col gap-4" data-testid="email-step-thread">
          <SelectField
            description={t("emailTemplates.step.threadHint")}
            label={t("emailTemplates.step.thread")}
            name={`${parentName}.threadMode`}
            options={threadModeOptions}
            placeholder={t("emailTemplates.step.threadDefault")}
            triggerValueChange={(value) => {
              if (value !== "campaign") {
                setValue(`${parentName}.threadCampaign`, undefined, {
                  shouldDirty: true,
                })
              }
            }}
          />
          {threadMode === "campaign" ? (
            <div
              className="flex flex-col gap-2"
              data-testid="email-step-thread-campaign"
            >
              <Label>{t("emailTemplates.step.threadCampaignPick")}</Label>
              <Select
                onValueChange={(value) => {
                  const [kind, id] = String(value).split(":")
                  setValue(
                    `${parentName}.threadCampaign`,
                    kind === "sequence"
                      ? { sequenceId: id }
                      : { broadcastId: id },
                    { shouldDirty: true },
                  )
                }}
                value={campaignValue}
              >
                <SelectTrigger className="w-full">
                  <SelectValue
                    placeholder={t("emailTemplates.step.threadCampaignPick")}
                  />
                </SelectTrigger>
                <SelectContent>
                  {campaignOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          {threadMode && threadMode !== "none" ? (
            <SelectField
              label={t("emailTemplates.step.onNoThread")}
              name={`${parentName}.onNoThread`}
              options={onNoThreadOptions}
              placeholder={t("emailTemplates.step.onNoThreadNew")}
            />
          ) : null}
        </div>
      ) : null}

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
      <HeaderPreviewLine name={`${parentName}.subject`} />
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

/** s227b: what a Liquid subject renders to, with and without contact fields. */
function HeaderPreviewLine({ name }: { name: string }) {
  const t = useTranslations()
  const { control } = useFormContext()
  const text = useWatch({ control, name }) as unknown
  const preview = useMemo(
    () => (typeof text === "string" ? headerPreview(text) : undefined),
    [text],
  )
  if (!preview) {
    return null
  }
  if (!preview.ok) {
    return (
      <p
        className="-mt-2 text-destructive text-xs"
        data-testid="subject-preview"
      >
        {t("emailTemplates.step.subjectPreviewError", { error: preview.error })}
      </p>
    )
  }
  return (
    <div
      className="-mt-2 text-muted-foreground text-xs"
      data-testid="subject-preview"
    >
      <p>{t("emailTemplates.step.subjectPreview", { text: preview.sample })}</p>
      <p>
        {t("emailTemplates.step.subjectPreviewEmpty", { text: preview.empty })}
      </p>
    </div>
  )
}
