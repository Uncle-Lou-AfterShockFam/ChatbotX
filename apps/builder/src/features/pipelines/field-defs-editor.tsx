"use client"

import type {
  DealFieldDef,
  DealFieldType,
} from "@chatbotx.io/database/partials"
import {
  dealFieldTypes,
  MAX_DEAL_FIELD_DEFS,
} from "@chatbotx.io/database/partials"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import { Input } from "@chatbotx.io/ui/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@chatbotx.io/ui/components/ui/select"
import { Switch } from "@chatbotx.io/ui/components/ui/switch"
import { Textarea } from "@chatbotx.io/ui/components/ui/textarea"
import { PlusIcon, TrashIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useRef, useState } from "react"

/** Options textarea text <-> the def's options list (one per line, blanks dropped). */
export const optionsFromText = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

const blankDef = (): DealFieldDef => ({
  key: "",
  label: "",
  type: "shortText",
  required: false,
})

type Row = { rowId: number; def: DealFieldDef }

/**
 * Per-pipeline custom deal fields. Every change is committed as the WHOLE
 * list (the settings PATCH replaces `fieldDefs`); the server's closed schema
 * is the validator, so a bad key or a select without options surfaces as the
 * action's error toast and the row stays editable.
 */
export function FieldDefsEditor({
  pipelineId,
  fieldDefs,
  onSave,
  saving,
}: {
  pipelineId: string
  fieldDefs: DealFieldDef[]
  onSave: (fieldDefs: DealFieldDef[]) => void
  saving: boolean
}) {
  const t = useTranslations()
  // Rows carry a local id so React keys survive removals (never the index).
  const nextRowId = useRef(0)
  const toRows = (defs: DealFieldDef[]): Row[] =>
    defs.map((def) => ({ rowId: nextRowId.current++, def }))
  const [rows, setRows] = useState<Row[]>(() => toRows(fieldDefs))
  const [synced, setSynced] = useState(fieldDefs)
  if (synced !== fieldDefs) {
    setSynced(fieldDefs)
    setRows(toRows(fieldDefs))
  }
  const defs = rows.map((r) => r.def)
  const dirty = JSON.stringify(defs) !== JSON.stringify(fieldDefs)
  const patch = (rowId: number, change: Partial<DealFieldDef>) =>
    setRows((prev) =>
      prev.map((row) => {
        if (row.rowId !== rowId) {
          return row
        }
        const next = { ...row.def, ...change }
        if (next.type !== "select") {
          next.options = undefined
        } else if (!next.options) {
          next.options = []
        }
        return { rowId, def: next }
      }),
    )

  return (
    <div className="space-y-2" data-testid={`field-defs-${pipelineId}`}>
      <div className="font-medium text-sm">{t("deals.fieldDefs.title")}</div>
      <p className="text-muted-foreground text-xs">
        {t("deals.fieldDefs.hint")}
      </p>
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          {t("deals.fieldDefs.none")}
        </p>
      ) : null}
      <div className="flex flex-col gap-2">
        {rows.map(({ rowId, def: row }) => (
          <div
            className="grid grid-cols-[1fr_1fr_auto_auto_auto] items-start gap-2 rounded-md border p-2"
            data-testid={`field-def-row-${rowId}`}
            key={rowId}
          >
            <Input
              aria-label={t("deals.fieldDefs.key")}
              data-testid={`field-def-key-${rowId}`}
              maxLength={40}
              onChange={(e) => patch(rowId, { key: e.target.value })}
              placeholder="roofType"
              title={t("deals.fieldDefs.keyHint")}
              value={row.key}
            />
            <Input
              aria-label={t("deals.fieldDefs.label")}
              data-testid={`field-def-label-${rowId}`}
              maxLength={60}
              onChange={(e) => patch(rowId, { label: e.target.value })}
              placeholder={t("deals.fieldDefs.label")}
              value={row.label}
            />
            <Select
              items={dealFieldTypes.options.map((type) => ({
                value: type,
                label: t(`deals.fieldDefs.types.${type}`),
              }))}
              onValueChange={(v) =>
                v && patch(rowId, { type: v as DealFieldType })
              }
              value={row.type}
            >
              <SelectTrigger
                className="w-32"
                data-testid={`field-def-type-${rowId}`}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {dealFieldTypes.options.map((type) => (
                  <SelectItem key={type} value={type}>
                    {t(`deals.fieldDefs.types.${type}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex items-center gap-1 pt-2 text-xs">
              <Switch
                aria-label={t("deals.fieldDefs.required")}
                checked={row.required}
                data-testid={`field-def-required-${rowId}`}
                onCheckedChange={(required) => patch(rowId, { required })}
                size="sm"
              />
              {t("deals.fieldDefs.required")}
            </div>
            <Button
              aria-label={t("deals.fieldDefs.remove")}
              data-testid={`field-def-remove-${rowId}`}
              onClick={() =>
                setRows((prev) => prev.filter((r) => r.rowId !== rowId))
              }
              size="icon"
              type="button"
              variant="ghost"
            >
              <TrashIcon />
            </Button>
            {row.type === "select" ? (
              <Textarea
                aria-label={t("deals.fieldDefs.options")}
                className="col-span-5"
                data-testid={`field-def-options-${rowId}`}
                onChange={(e) =>
                  patch(rowId, { options: optionsFromText(e.target.value) })
                }
                placeholder={t("deals.fieldDefs.options")}
                rows={2}
                value={(row.options ?? []).join("\n")}
              />
            ) : null}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <Button
          data-testid={`field-def-add-${pipelineId}`}
          disabled={rows.length >= MAX_DEAL_FIELD_DEFS}
          onClick={() =>
            setRows((prev) => [
              ...prev,
              { rowId: nextRowId.current++, def: blankDef() },
            ])
          }
          size="sm"
          type="button"
          variant="outline"
        >
          <PlusIcon />
          {t("deals.fieldDefs.add")}
        </Button>
        <Button
          data-testid={`field-def-save-${pipelineId}`}
          disabled={!dirty || saving}
          onClick={() => onSave(defs)}
          size="sm"
          type="button"
        >
          {t("actions.save")}
        </Button>
      </div>
    </div>
  )
}
