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
import { useDebouncedCallback } from "@chatbotx.io/ui/hooks/use-debounced-callback"
import { cn } from "@chatbotx.io/ui/lib/utils"
import {
  type CollisionDetection,
  closestCenter,
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core"
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
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
  blocksAt,
  type Container,
  findBlock,
  insertBlock,
  moveBlockTo,
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
/** Droppable ids of the lists themselves (a block's id is its own droppable). */
const ROOT_DROP = "container:root"
export const containerDropId = (at: Container) =>
  at.kind === "root" ? ROOT_DROP : `container:${at.columnsId}:${at.column}`
const CONTAINER_ID = /^container:(.+):(\d+)$/

/**
 * Where a drop on droppable `id` lands: on a block, its position; on a list
 * (an empty column, the space below the last block), its end.
 */
export function dropTarget(
  doc: EmailDocument,
  id: string,
): { at: Container; index: number } | undefined {
  if (id === ROOT_DROP) {
    return { at: ROOT, index: doc.blocks.length }
  }
  const column = CONTAINER_ID.exec(id)
  if (column) {
    const at: Container = {
      kind: "column",
      columnsId: column[1] as string,
      column: Number(column[2]),
    }
    const blocks = blocksAt(doc, at)
    return blocks ? { at, index: blocks.length } : undefined
  }
  const found = findBlock(doc, id)
  return found ? { at: found.at, index: found.index } : undefined
}

const inColumn = (doc: EmailDocument, id: string) =>
  (id.startsWith("container:") && id !== ROOT_DROP) ||
  findBlock(doc, id)?.at.kind === "column"

/**
 * s223b: one drag context for the whole canvas, so a block moves between the
 * top level and any column. The pointer's innermost target wins: a block
 * inside a column beats that column, which beats the columns block around
 * it. A columns block only ever targets the top level (they never nest).
 */
function canvasCollision(doc: () => EmailDocument): CollisionDetection {
  return (args) => {
    const current = doc()
    const moving = findBlock(current, String(args.active.id))?.block
    const scoped =
      moving?.type === "columns"
        ? {
            ...args,
            droppableContainers: args.droppableContainers.filter(
              (c) => !inColumn(current, String(c.id)),
            ),
          }
        : args
    const hits = pointerWithin(scoped)
    if (hits.length === 0) {
      return closestCenter(scoped)
    }
    const inner = hits.filter((h) => inColumn(current, String(h.id)))
    const pool = inner.length > 0 ? inner : hits
    const block = pool.find((h) => !String(h.id).startsWith("container:"))
    return [block ?? (pool[0] as (typeof hits)[number])]
  }
}
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
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: block.id })
  return (
    <div
      className={cn(
        "rounded-md border bg-background",
        selected && "border-primary",
        invalid && "border-destructive",
        isDragging && "opacity-50",
      )}
      data-testid={`email-block-${block.type}`}
      ref={setNodeRef}
      role="presentation"
      style={{ transform: CSS.Translate.toString(transform), transition }}
    >
      <div className="flex min-w-0 items-center gap-2 p-2">
        <Button
          aria-label={t("reorder")}
          className="cursor-grab touch-none"
          ref={setActivatorNodeRef}
          size="icon"
          type="button"
          variant="ghost"
          {...attributes}
          {...listeners}
        >
          <GripVerticalIcon className="size-4" />
        </Button>
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
  onTarget: (at: Container) => void
}) {
  const t = useTranslations("emailTemplates.editor")
  const { selectedId, invalidIds, target, assets, onSelect, onRemove } = rest
  // The list is a drop target too: an empty column, or below the last block.
  const { setNodeRef } = useDroppable({ id: containerDropId(at) })
  return (
    <SortableContext
      items={blocks.map((b) => b.id)}
      strategy={verticalListSortingStrategy}
    >
      <div
        className={cn(
          "flex flex-col gap-1",
          at.kind === "column" && "min-h-10",
        )}
        data-testid={`email-drop-${at.kind === "root" ? "root" : `${at.column}`}`}
        ref={setNodeRef}
      >
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
    </SortableContext>
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
  onValidChange,
}: {
  workspaceId: string
  value: EmailDocument
  onChange: (doc: EmailDocument) => void
  /** False while the current draft is unrendered or has schema issues. */
  onValidChange?: (valid: boolean) => void
}) {
  const t = useTranslations("emailTemplates.editor")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [chosenTarget, setTarget] = useState<Container>(ROOT)
  // A column target whose column is gone (3 -> 2 columns, block removed)
  // falls back to the top level: inserting there would be a silent no-op.
  const target = blocksAt(value, chosenTarget) ? chosenTarget : ROOT
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

  // Save waits for a render of THIS draft that passed; a preview outage
  // (network, 429) does not block it, the server validates again.
  const valid =
    previewDoc === value &&
    !preview.isFetching &&
    (result?.ok === true || preview.isError === true)
  useEffect(() => {
    onValidChange?.(valid)
  }, [valid, onValidChange])

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

  // Drag handlers read the newest draft: a cross-container move during the
  // drag re-renders before the next dragover arrives.
  const valueRef = useRef(value)
  valueRef.current = value
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  )
  const collision = useMemo(() => canvasCollision(() => valueRef.current), [])
  // Entering another list moves the block there at once, so the lists
  // re-flow under the pointer; the drop then orders it inside its list.
  const onDragOver = ({ active, over }: DragOverEvent) => {
    const doc = valueRef.current
    const from = findBlock(doc, String(active.id))
    const to = over ? dropTarget(doc, String(over.id)) : undefined
    if (from && to && containerDropId(from.at) !== containerDropId(to.at)) {
      onChange(moveBlockTo(doc, String(active.id), to.at, to.index))
    }
  }
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const doc = valueRef.current
    const from = findBlock(doc, String(active.id))
    const to = over ? dropTarget(doc, String(over.id)) : undefined
    if (
      from &&
      to &&
      (containerDropId(from.at) !== containerDropId(to.at) ||
        from.index !== to.index)
    ) {
      onChange(moveBlockTo(doc, String(active.id), to.at, to.index))
    }
  }

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
              <DndContext
                collisionDetection={collision}
                onDragEnd={onDragEnd}
                onDragOver={onDragOver}
                sensors={sensors}
              >
                <BlockList
                  assets={assets}
                  at={ROOT}
                  blocks={value.blocks}
                  invalidIds={invalidIds}
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
              </DndContext>
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
