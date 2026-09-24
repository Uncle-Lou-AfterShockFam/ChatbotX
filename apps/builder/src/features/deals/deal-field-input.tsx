"use client"

import type { DealFieldDef } from "@chatbotx.io/database/partials"
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
import { useTranslations } from "next-intl"
import { useEffect, useState } from "react"

const NONE = "__none"

/** `value` as the string an <input> shows; the reverse is `parseFieldInput`. */
function toInputString(value: unknown): string {
  if (value === null || value === undefined) {
    return ""
  }
  if (typeof value === "string") {
    return value
  }
  if (typeof value === "number") {
    return String(value)
  }
  return ""
}

/**
 * Turn what the control produced into the typed value the API validates
 * against the field def: numbers become numbers, empty becomes null (clear),
 * dates stay ISO date strings. An unparsable number is returned as the raw
 * string so the server's 422 names the field.
 */
export function parseFieldInput(def: DealFieldDef, raw: string): unknown {
  if (raw.trim() === "") {
    return null
  }
  if (def.type === "number") {
    const n = Number(raw)
    return Number.isFinite(n) ? n : raw
  }
  return raw
}

/**
 * One custom deal field, rendered by its def's type. Text and number inputs
 * commit on blur (like the drawer's title/value); select, boolean and date
 * commit on change. `onCommit` receives the typed value or null (clear).
 */
export function DealFieldInput({
  def,
  value,
  onCommit,
  testId,
}: {
  def: DealFieldDef
  value: unknown
  onCommit: (value: unknown) => void
  testId?: string
}) {
  const t = useTranslations()
  const [draft, setDraft] = useState(toInputString(value))
  useEffect(() => {
    setDraft(toInputString(value))
  }, [value])
  const commitDraft = () => {
    const next = parseFieldInput(def, draft)
    if (JSON.stringify(next) !== JSON.stringify(value ?? null)) {
      onCommit(next)
    }
  }

  switch (def.type) {
    case "boolean":
      return (
        <Switch
          aria-label={def.label}
          checked={value === true}
          data-testid={testId}
          onCheckedChange={(checked) => onCommit(checked)}
        />
      )
    case "select":
      return (
        <Select
          onValueChange={(next) =>
            onCommit(next === NONE || !next ? null : String(next))
          }
          value={typeof value === "string" && value ? value : NONE}
        >
          <SelectTrigger data-testid={testId}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>{t("actions.pleaseSelect")}</SelectItem>
            {(def.options ?? []).map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )
    case "date":
      return (
        <Input
          aria-label={def.label}
          data-testid={testId}
          onChange={(e) =>
            onCommit(e.target.value === "" ? null : e.target.value)
          }
          type="date"
          value={toInputString(value).slice(0, 10)}
        />
      )
    case "longText":
      return (
        <Textarea
          aria-label={def.label}
          data-testid={testId}
          maxLength={4000}
          onBlur={commitDraft}
          onChange={(e) => setDraft(e.target.value)}
          rows={3}
          value={draft}
        />
      )
    default:
      return (
        <Input
          aria-label={def.label}
          data-testid={testId}
          inputMode={def.type === "number" ? "decimal" : undefined}
          maxLength={def.type === "number" ? 32 : 255}
          onBlur={commitDraft}
          onChange={(e) => setDraft(e.target.value)}
          type={def.type === "number" ? "number" : "text"}
          value={draft}
        />
      )
  }
}
