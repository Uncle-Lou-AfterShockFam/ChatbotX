"use client"

import {
  type Block,
  type EmailDocument,
  fontFamilies,
  MAX_HTML_BLOCK_LENGTH,
} from "@chatbotx.io/email-document"
import { Badge } from "@chatbotx.io/ui/components/ui/badge"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import { Card, CardContent } from "@chatbotx.io/ui/components/ui/card"
import { Input } from "@chatbotx.io/ui/components/ui/input"
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
import { useDebouncedCallback } from "@chatbotx.io/ui/hooks/use-debounced-callback"
import { cn } from "@chatbotx.io/ui/lib/utils"
import {
  FileUpIcon,
  GripVerticalIcon,
  PlusIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { MediaLibraryTrigger } from "@/features/media-library/components/media-library-trigger"
import {
  BLOCK_TYPES,
  type BlockType,
  blockIdAtPath,
  type Container,
  findBlock,
  insertBlock,
  moveBlock,
  newBlock,
  ROOT,
  removeBlock,
  setColumnCount,
  updateBlock,
} from "../lib/document-model"
import { useEmailTemplatePreview } from "../provider/email-template-hooks"
import { BlockInspector } from "./block-inspector"

export type AssetInfo = { url: string; name: string; mimeType?: string }

const PREVIEW_DEBOUNCE_MS = 700
const TAG_RE = /<[^>]*>/g
const SPACE_RE = /\s+/g

/** A one-line summary of a block for the canvas (the iframe shows the real render). */
function blockSummary(block: Block, assets: Record<string, AssetInfo>) {
  const plain = (html: string) =>
    html.replace(TAG_RE, " ").replace(SPACE_RE, " ").trim().slice(0, 80)
  switch (block.type) {
    case "heading":
    case "text":
      return plain(block.text)
    case "image":
      return typeof block.src === "string"
        ? block.src
        : (assets[block.src.fileId]?.name ?? `#${block.src.fileId}`)
    case "button":
      return block.label
    case "attachment":
      return assets[block.asset.fileId]?.name ?? `#${block.asset.fileId}`
    case "html":
      return plain(block.html)
    case "code":
      return block.text.slice(0, 80)
    case "spacer":
      return `${block.height}px`
    default:
      return ""
  }
}

function BlockRow({
  block,
  selected,
  invalid,
  assets,
  onSelect,
  onRemove,
  children,
}: {
  block: Block
  selected: boolean
  invalid: boolean
  assets: Record<string, AssetInfo>
  onSelect: () => void
  onRemove: () => void
  children?: React.ReactNode
}) {
  const t = useTranslations("emailTemplates.editor")
  return (
    <SortableItem
      render={
        <div
          className={cn(
            "rounded-md border bg-background",
            selected && "border-primary",
            invalid && "border-destructive",
          )}
          data-testid={`email-block-${block.type}`}
          role="presentation"
        >
          <div className="flex min-w-0 items-center gap-2 p-2">
            <SortableItemHandle
              render={
                <Button
                  aria-label={t("reorder")}
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <GripVerticalIcon className="size-4" />
                </Button>
              }
            />
            <button
              className="flex min-w-0 grow items-center gap-2 text-start"
              onClick={onSelect}
              type="button"
            >
              <Badge variant="outline">{t(`blocks.${block.type}`)}</Badge>
              <span className="min-w-0 truncate text-muted-foreground text-sm">
                {blockSummary(block, assets)}
              </span>
            </button>
            <Button
              aria-label={t("removeBlock")}
              onClick={onRemove}
              size="icon"
              type="button"
              variant="ghost"
            >
              <Trash2Icon className="size-4" />
            </Button>
          </div>
          {children}
        </div>
      }
      value={block.id}
    />
  )
}

function BlockList({
  blocks,
  at,
  ...rest
}: {
  blocks: Block[]
  at: Container
  selectedId: string | null
  invalidIds: Set<string>
  target: Container
  assets: Record<string, AssetInfo>
  onSelect: (id: string) => void
  onRemove: (id: string) => void
  onMove: (at: Container, from: number, to: number) => void
  onTarget: (at: Container) => void
}) {
  const t = useTranslations("emailTemplates.editor")
  const { selectedId, invalidIds, target, assets, onSelect, onRemove } = rest
  return (
    <Sortable
      getItemValue={(b: Block) => b.id}
      onMove={({ activeIndex, overIndex }) =>
        rest.onMove(at, activeIndex, overIndex)
      }
      value={blocks}
    >
      <SortableContent>
        <div className="flex flex-col gap-1">
          {blocks.map((block) => (
            <BlockRow
              assets={assets}
              block={block}
              invalid={invalidIds.has(block.id)}
              key={block.id}
              onRemove={() => onRemove(block.id)}
              onSelect={() => onSelect(block.id)}
              selected={selectedId === block.id}
            >
              {block.type === "columns" ? (
                <div
                  className="grid gap-2 border-t p-2"
                  style={{
                    gridTemplateColumns: `repeat(${block.columns.length}, minmax(0, 1fr))`,
                  }}
                >
                  {block.columns.map((col, column) => {
                    const here: Container = {
                      kind: "column",
                      columnsId: block.id,
                      column,
                    }
                    const active =
                      target.kind === "column" &&
                      target.columnsId === block.id &&
                      target.column === column
                    return (
                      <div
                        className={cn(
                          "min-w-0 space-y-1 rounded-md border border-dashed p-1",
                          active && "border-primary",
                        )}
                        // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional
                        key={column}
                      >
                        <Button
                          className="w-full"
                          data-testid={`email-column-target-${column}`}
                          onClick={() => rest.onTarget(active ? ROOT : here)}
                          size="sm"
                          type="button"
                          variant={active ? "secondary" : "ghost"}
                        >
                          {t("columnN", { n: column + 1 })}
                        </Button>
                        <BlockList {...rest} at={here} blocks={col.blocks} />
                      </div>
                    )
                  })}
                </div>
              ) : null}
            </BlockRow>
          ))}
        </div>
      </SortableContent>
    </Sortable>
  )
}

function Palette({
  workspaceId,
  target,
  onAdd,
  onAsset,
  onClearTarget,
}: {
  workspaceId: string
  target: Container
  onAdd: (type: BlockType, extra?: { fileId?: string; html?: string }) => void
  onAsset: (fileId: string, asset: AssetInfo) => void
  onClearTarget: () => void
}) {
  const t = useTranslations("emailTemplates.editor")
  const fileInput = useRef<HTMLInputElement>(null)
  const types = BLOCK_TYPES.filter(
    (type) => !(target.kind === "column" && type === "columns"),
  )

  const importHtml = async (file: File) => {
    const html = await file.text()
    if (html.length > MAX_HTML_BLOCK_LENGTH) {
      toast.error(t("htmlTooLarge", { max: MAX_HTML_BLOCK_LENGTH }))
      return
    }
    onAdd("html", { html })
  }

  return (
    <div className="space-y-2">
      {target.kind === "column" ? (
        <div className="flex items-center justify-between gap-2 text-muted-foreground text-xs">
          <span>{t("addingToColumn", { n: target.column + 1 })}</span>
          <Button
            aria-label={t("addToRoot")}
            onClick={onClearTarget}
            size="icon"
            type="button"
            variant="ghost"
          >
            <XIcon className="size-3" />
          </Button>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-1">
        {types.map((type) =>
          type === "image" || type === "attachment" ? (
            <MediaLibraryTrigger
              key={type}
              onSelect={(file) => {
                const fileId = String(file.id)
                onAsset(fileId, {
                  url: file.url,
                  name: file.name,
                  mimeType: file.mimeType,
                })
                onAdd(type, { fileId })
              }}
              workspaceId={workspaceId}
            >
              <Button
                data-testid={`email-add-${type}`}
                size="sm"
                type="button"
                variant="outline"
              >
                <PlusIcon className="me-1 size-3" />
                {t(`blocks.${type}`)}
              </Button>
            </MediaLibraryTrigger>
          ) : (
            <Button
              data-testid={`email-add-${type}`}
              key={type}
              onClick={() => onAdd(type)}
              size="sm"
              type="button"
              variant="outline"
            >
              <PlusIcon className="me-1 size-3" />
              {t(`blocks.${type}`)}
            </Button>
          ),
        )}
        <Button
          data-testid="email-import-html"
          onClick={() => fileInput.current?.click()}
          size="sm"
          type="button"
          variant="outline"
        >
          <FileUpIcon className="me-1 size-3" />
          {t("importHtml")}
        </Button>
        <input
          accept=".html,.htm,text/html"
          className="hidden"
          data-testid="email-import-html-input"
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = ""
            if (file) {
              importHtml(file).catch(() => toast.error(t("htmlReadFailed")))
            }
          }}
          ref={fileInput}
          type="file"
        />
      </div>
    </div>
  )
}

function DocumentSettings({
  settings,
  onChange,
}: {
  settings: EmailDocument["settings"]
  onChange: (settings: EmailDocument["settings"]) => void
}) {
  const t = useTranslations("emailTemplates.editor")
  const fonts = fontFamilies.options
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1">
        <Label className="text-xs">{t("preheader")}</Label>
        <Input
          data-testid="email-preheader"
          maxLength={150}
          onChange={(e) =>
            onChange({ ...settings, preheader: e.target.value || undefined })
          }
          value={settings.preheader ?? ""}
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">{t("font")}</Label>
        <Select
          items={fonts.map((f) => ({ value: f, label: t(`fonts.${f}`) }))}
          onValueChange={(v) =>
            onChange({
              ...settings,
              fontFamily: String(v) as (typeof fonts)[number],
            })
          }
          value={settings.fontFamily ?? "system"}
        >
          <SelectTrigger aria-label={t("font")} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {fonts.map((f) => (
              <SelectItem key={f} value={f}>
                {t(`fonts.${f}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label className="text-xs">{t("width")}</Label>
        <Input
          max={800}
          min={480}
          onChange={(e) =>
            onChange({
              ...settings,
              width: e.target.value ? Number(e.target.value) : undefined,
            })
          }
          placeholder="600"
          type="number"
          value={settings.width ?? ""}
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">{t("background")}</Label>
        <Input
          onChange={(e) =>
            onChange({ ...settings, background: e.target.value })
          }
          type="color"
          value={settings.background ?? "#ffffff"}
        />
      </div>
    </div>
  )
}

/**
 * The newsletter block editor (B2 phase 3): a sortable block list (top level
 * and inside columns), a palette of exactly the schema's blocks, a per-block
 * inspector and the server-rendered preview. Every change goes through the
 * pure model in lib/document-model.ts; the preview reports schema issues by
 * path, and the offending block is outlined.
 */
export function EmailDocumentEditor({
  workspaceId,
  value,
  onChange,
}: {
  workspaceId: string
  value: EmailDocument
  onChange: (doc: EmailDocument) => void
}) {
  const t = useTranslations("emailTemplates.editor")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [target, setTarget] = useState<Container>(ROOT)
  const [assets, setAssets] = useState<Record<string, AssetInfo>>({})
  const [previewDoc, setPreviewDoc] = useState<EmailDocument>(value)
  const schedulePreview = useDebouncedCallback(
    (doc: EmailDocument) => setPreviewDoc(doc),
    PREVIEW_DEBOUNCE_MS,
  )
  useEffect(() => {
    schedulePreview(value)
  }, [value, schedulePreview])

  const preview = useEmailTemplatePreview(
    workspaceId,
    previewDoc,
    previewDoc.blocks.length > 0,
  )
  const result = preview.data

  // Names/urls of a saved document's media come back with its preview.
  useEffect(() => {
    if (result?.ok) {
      setAssets((current) => ({ ...result.assets, ...current }))
    }
  }, [result])

  const invalidIds = useMemo(() => {
    const ids = new Set<string>()
    if (result && !result.ok) {
      for (const issue of result.issues) {
        const id = blockIdAtPath(previewDoc, issue.path)
        if (id) {
          ids.add(id)
        }
      }
    }
    return ids
  }, [result, previewDoc])

  const selected = selectedId ? findBlock(value, selectedId)?.block : undefined
  const addAsset = (fileId: string, asset: AssetInfo) =>
    setAssets((current) => ({ ...current, [fileId]: asset }))

  const add = (type: BlockType, extra?: { fileId?: string; html?: string }) => {
    const block = newBlock(type, extra)
    onChange(insertBlock(value, target, block))
    setSelectedId(block.id)
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="min-w-0 space-y-4">
        <Card>
          <CardContent className="space-y-3 p-3">
            <Palette
              onAdd={add}
              onAsset={addAsset}
              onClearTarget={() => setTarget(ROOT)}
              target={target}
              workspaceId={workspaceId}
            />
            {value.blocks.length === 0 ? (
              <p className="py-6 text-center text-muted-foreground text-sm">
                {t("empty")}
              </p>
            ) : (
              <BlockList
                assets={assets}
                at={ROOT}
                blocks={value.blocks}
                invalidIds={invalidIds}
                onMove={(at, from, to) =>
                  onChange(moveBlock(value, at, from, to))
                }
                onRemove={(id) => {
                  onChange(removeBlock(value, id))
                  if (selectedId === id) {
                    setSelectedId(null)
                  }
                  if (target.kind === "column" && target.columnsId === id) {
                    setTarget(ROOT)
                  }
                }}
                onSelect={setSelectedId}
                onTarget={setTarget}
                selectedId={selectedId}
                target={target}
              />
            )}
          </CardContent>
        </Card>
        {selected ? (
          <Card data-testid="email-block-inspector">
            <CardContent className="space-y-3 p-3">
              <p className="font-medium text-sm">
                {t(`blocks.${selected.type}`)}
              </p>
              <BlockInspector
                assets={assets}
                block={selected}
                onAsset={addAsset}
                onColumns={(count) =>
                  onChange(setColumnCount(value, selected.id, count))
                }
                onPatch={(patch) =>
                  onChange(updateBlock(value, selected.id, patch))
                }
                workspaceId={workspaceId}
              />
            </CardContent>
          </Card>
        ) : null}
        <Card>
          <CardContent className="space-y-2 p-3">
            <p className="font-medium text-sm">{t("settings")}</p>
            <DocumentSettings
              onChange={(settings) => onChange({ ...value, settings })}
              settings={value.settings}
            />
          </CardContent>
        </Card>
      </div>
      <Card className="min-w-0 xl:sticky xl:top-4 xl:self-start">
        <CardContent className="space-y-2 p-3">
          <p className="font-medium text-sm">{t("preview")}</p>
          {result && !result.ok ? (
            <ul
              className="space-y-1 text-destructive text-xs"
              data-testid="email-preview-issues"
            >
              {result.issues.map((issue) => (
                <li key={`${issue.path}:${issue.message}`}>
                  {issue.path ? `${issue.path}: ` : ""}
                  {issue.message}
                </li>
              ))}
            </ul>
          ) : null}
          {preview.error ? (
            <p className="text-muted-foreground text-xs">
              {t("previewUnavailable")}
            </p>
          ) : null}
          {result?.ok && result.missing.length > 0 ? (
            <p className="text-muted-foreground text-xs">
              {t("previewMissing", { list: result.missing.join(", ") })}
            </p>
          ) : null}
          {result?.ok ? (
            <iframe
              className="h-[640px] w-full rounded-md border bg-white"
              data-testid="email-preview-frame"
              sandbox=""
              srcDoc={result.html}
              title={t("preview")}
            />
          ) : (
            <p className="py-10 text-center text-muted-foreground text-sm">
              {value.blocks.length === 0 ? t("empty") : t("previewPending")}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
