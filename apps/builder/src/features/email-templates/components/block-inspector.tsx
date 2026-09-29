"use client"

import type { Block } from "@chatbotx.io/email-document"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import { Input } from "@chatbotx.io/ui/components/ui/input"
import { Label } from "@chatbotx.io/ui/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@chatbotx.io/ui/components/ui/select"
import { Textarea } from "@chatbotx.io/ui/components/ui/textarea"
import { createId } from "@chatbotx.io/utils"
import { useTranslations } from "next-intl"
import type { ReactNode } from "react"
import { MediaLibraryTrigger } from "@/features/media-library/components/media-library-trigger"
import { useFlowOptions } from "../provider/email-template-hooks"
import type { AssetInfo } from "./email-document-editor"
import { RichTextField } from "./rich-text-field"

type Patch = (patch: Partial<Block>) => void
type Align = "left" | "center" | "right"

const ALIGNS: Align[] = ["left", "center", "right"]
const HEX = /^#[0-9a-fA-F]{6}$/

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  )
}

function SimpleSelect<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
  label: string
}) {
  return (
    <Select
      items={options}
      onValueChange={(v) => onChange(String(v ?? "") as T)}
      value={value}
    >
      <SelectTrigger aria-label={label} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function AlignField({
  value,
  onChange,
}: {
  value: Align | undefined
  onChange: (value: Align) => void
}) {
  const t = useTranslations("emailTemplates.editor")
  return (
    <Field label={t("align")}>
      <SimpleSelect
        label={t("align")}
        onChange={onChange}
        options={ALIGNS.map((a) => ({ value: a, label: t(`aligns.${a}`) }))}
        value={value ?? "left"}
      />
    </Field>
  )
}

function MediaField({
  workspaceId,
  fileId,
  assets,
  onPick,
  label,
}: {
  workspaceId: string
  fileId: string | undefined
  assets: Record<string, AssetInfo>
  onPick: (file: AssetInfo & { id: string }) => void
  label: string
}) {
  const t = useTranslations("emailTemplates.editor")
  const asset = fileId ? assets[fileId] : undefined
  return (
    <Field label={label}>
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-muted-foreground text-sm">
          {asset?.name ?? (fileId ? `#${fileId}` : t("noFile"))}
        </span>
        <MediaLibraryTrigger
          onSelect={(file) =>
            onPick({
              id: String(file.id),
              url: file.url,
              name: file.name,
              mimeType: file.mimeType,
            })
          }
          workspaceId={workspaceId}
        >
          <Button size="sm" type="button" variant="outline">
            {t("chooseFile")}
          </Button>
        </MediaLibraryTrigger>
      </div>
    </Field>
  )
}

/** The settings panel of the selected block; every edit is a shallow patch. */
export function BlockInspector({
  block,
  workspaceId,
  assets,
  onAsset,
  onPatch,
  onColumns,
}: {
  block: Block
  workspaceId: string
  assets: Record<string, AssetInfo>
  onAsset: (fileId: string, asset: AssetInfo) => void
  onPatch: Patch
  onColumns: (count: 2 | 3) => void
}) {
  const t = useTranslations("emailTemplates.editor")
  const flows = useFlowOptions(workspaceId)

  switch (block.type) {
    case "heading":
      return (
        <div className="space-y-3">
          <Field label={t("level")}>
            <SimpleSelect
              label={t("level")}
              onChange={(v) => onPatch({ level: Number(v) as 1 | 2 | 3 })}
              options={(["1", "2", "3"] as const).map((l) => ({
                value: l,
                label: `H${l}`,
              }))}
              value={String(block.level) as "1" | "2" | "3"}
            />
          </Field>
          <AlignField
            onChange={(align) => onPatch({ align })}
            value={block.align}
          />
          <RichTextField
            key={block.id}
            minimal
            onChange={(text) => onPatch({ text })}
            testId="email-block-richtext"
            value={block.text}
          />
        </div>
      )
    case "text":
      return (
        <div className="space-y-3">
          <AlignField
            onChange={(align) => onPatch({ align })}
            value={block.align}
          />
          <RichTextField
            key={block.id}
            onChange={(text) => onPatch({ text })}
            testId="email-block-richtext"
            value={block.text}
          />
        </div>
      )
    case "image": {
      const fileId =
        typeof block.src === "string" ? undefined : block.src.fileId
      return (
        <div className="space-y-3">
          <MediaField
            assets={assets}
            fileId={fileId}
            label={t("image")}
            onPick={(file) => {
              onAsset(file.id, file)
              onPatch({ src: { kind: "media", fileId: file.id } })
            }}
            workspaceId={workspaceId}
          />
          <Field label={t("imageUrl")}>
            <Input
              onChange={(e) => {
                // Clearing the URL keeps the picked media file (an empty
                // src is never valid).
                if (e.target.value !== "" || typeof block.src === "string") {
                  onPatch({ src: e.target.value })
                }
              }}
              placeholder="https://"
              value={typeof block.src === "string" ? block.src : ""}
            />
          </Field>
          <Field label={t("alt")}>
            <Input
              maxLength={200}
              onChange={(e) => onPatch({ alt: e.target.value })}
              value={block.alt}
            />
          </Field>
          <Field label={t("href")}>
            <Input
              onChange={(e) =>
                onPatch({ href: e.target.value.trim() || undefined })
              }
              placeholder="https://"
              value={block.href ?? ""}
            />
          </Field>
          <Field label={t("width")}>
            <Input
              max={800}
              min={1}
              onChange={(e) =>
                onPatch({
                  width: e.target.value ? Number(e.target.value) : undefined,
                })
              }
              type="number"
              value={block.width ?? ""}
            />
          </Field>
        </div>
      )
    }
    case "button": {
      const action = block.action
      const flowId =
        action.kind === "flow" ? String(action.beforeStep.flowId ?? "") : ""
      return (
        <div className="space-y-3">
          <Field label={t("label")}>
            <Input
              data-testid="email-button-label"
              maxLength={40}
              onChange={(e) => onPatch({ label: e.target.value })}
              value={block.label}
            />
          </Field>
          <Field label={t("action")}>
            <SimpleSelect
              label={t("action")}
              onChange={(kind) =>
                onPatch({
                  action:
                    kind === "url"
                      ? { kind: "url", url: "" }
                      : {
                          kind: "flow",
                          beforeStep: {
                            id: createId(),
                            stepType: "startExternalFlow",
                            flowId: flows.data?.[0]?.value ?? "",
                          },
                          steps: [],
                        },
                })
              }
              options={[
                { value: "url", label: t("actions.url") },
                { value: "flow", label: t("actions.flow") },
              ]}
              value={action.kind}
            />
          </Field>
          {action.kind === "url" ? (
            <Field label={t("url")}>
              <Input
                data-testid="email-button-url"
                onChange={(e) =>
                  onPatch({ action: { kind: "url", url: e.target.value } })
                }
                value={action.url}
              />
            </Field>
          ) : (
            <Field label={t("flow")}>
              <SimpleSelect
                label={t("flow")}
                onChange={(value) =>
                  onPatch({
                    action: {
                      ...action,
                      beforeStep: { ...action.beforeStep, flowId: value },
                    },
                  })
                }
                options={flows.data ?? []}
                value={flowId}
              />
            </Field>
          )}
          <AlignField
            onChange={(align) => onPatch({ align })}
            value={block.align}
          />
          <Field label={t("color")}>
            <Input
              className="h-9 w-14 cursor-pointer p-1"
              onChange={(e) =>
                onPatch({
                  color: HEX.test(e.target.value) ? e.target.value : undefined,
                })
              }
              type="color"
              value={block.color ?? "#111111"}
            />
          </Field>
        </div>
      )
    }
    case "spacer":
      return (
        <Field label={t("height")}>
          <Input
            max={96}
            min={4}
            onChange={(e) =>
              onPatch({
                height: Math.min(96, Math.max(4, Number(e.target.value) || 4)),
              })
            }
            type="number"
            value={block.height}
          />
        </Field>
      )
    case "columns":
      return (
        <Field label={t("columnCount")}>
          <SimpleSelect
            label={t("columnCount")}
            onChange={(v) => onColumns(v === "3" ? 3 : 2)}
            options={[
              { value: "2", label: "2" },
              { value: "3", label: "3" },
            ]}
            value={String(block.columns.length) as "2" | "3"}
          />
        </Field>
      )
    case "html":
      return (
        <div className="space-y-2">
          <Field label={t("html")}>
            <Textarea
              className="min-h-40 font-mono text-xs"
              data-testid="email-html-block"
              maxLength={50 * 1024}
              onChange={(e) => onPatch({ html: e.target.value })}
              value={block.html}
            />
          </Field>
          <p className="text-muted-foreground text-xs">{t("htmlNote")}</p>
        </div>
      )
    case "attachment":
      return (
        <div className="space-y-2">
          <MediaField
            assets={assets}
            fileId={block.asset.fileId}
            label={t("attachment")}
            onPick={(file) => {
              onAsset(file.id, file)
              onPatch({ asset: { kind: "media", fileId: file.id } })
            }}
            workspaceId={workspaceId}
          />
          <p className="text-muted-foreground text-xs">{t("attachmentNote")}</p>
        </div>
      )
    case "code":
      return (
        <Field label={t("code")}>
          <Textarea
            className="min-h-32 font-mono text-xs"
            onChange={(e) => onPatch({ text: e.target.value })}
            value={block.text}
          />
        </Field>
      )
    default:
      return <p className="text-muted-foreground text-sm">{t("noSettings")}</p>
  }
}
