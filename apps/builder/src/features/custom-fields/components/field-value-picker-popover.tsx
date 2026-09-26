"use client"

import { Button } from "@chatbotx.io/ui/components/ui/button"
import { Calendar } from "@chatbotx.io/ui/components/ui/calendar"
import { Checkbox } from "@chatbotx.io/ui/components/ui/checkbox"
import { TimePicker } from "@chatbotx.io/ui/components/ui/date-picker"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@chatbotx.io/ui/components/ui/popover"
import { multiSelectItems } from "@chatbotx.io/utils/custom-field"
import { format, parse } from "date-fns"
import { useTranslations } from "next-intl"
import { type ReactNode, useMemo, useRef, useState } from "react"
import { useFormContext } from "react-hook-form"

export type FieldValuePickerKind =
  | "date"
  | "datetime"
  | "boolean"
  | "select"
  | "multiSelect"

type FieldValuePickerPopoverProps = {
  kind: FieldValuePickerKind
  /** react-hook-form path the picked value is written to. */
  name: string
  /**
   * Include seconds in the datetime value (`yyyy-MM-dd HH:mm:ss`). Defaults
   * to true; the contact-filter condition value uses minutes only.
   */
  withSeconds?: boolean
  /** s203: the option list of a select / multiSelect field. */
  options?: readonly string[]
  /**
   * Renders the wrapped free-text input. The `inputKey` MUST be passed as the
   * input's `key`: the tiptap editor only reads the form value on mount, so a
   * picked value would otherwise leave the visible text stale.
   */
  children: (inputKey: number) => ReactNode
}

/**
 * Wraps a free-text value input with a click-to-open picker for temporal and
 * boolean field types: clicking the text area opens a calendar (+ time for
 * datetime) or a true/false chooser that writes the picked value back into
 * the same form field — typing and {{variable}} tokens keep working
 * alongside the picker. Shared by the Set Custom Field step editor and the
 * contact-filter condition dialog.
 */
export function FieldValuePickerPopover({
  kind,
  name,
  withSeconds = true,
  options = [],
  children,
}: FieldValuePickerPopoverProps) {
  const t = useTranslations()
  const form = useFormContext()

  const [isPickerOpen, setIsPickerOpen] = useState(false)
  // Bumped after a pick to remount the wrapped input — see `children` doc.
  const [inputKey, setInputKey] = useState(0)
  const isClickInInputRef = useRef(false)

  const valueFormat =
    kind === "date"
      ? "yyyy-MM-dd"
      : `yyyy-MM-dd HH:mm${withSeconds ? ":ss" : ""}`
  const watchedValue = form.watch(name)
  const pickedDate = useMemo(() => {
    if (
      !(kind === "date" || kind === "datetime") ||
      typeof watchedValue !== "string"
    ) {
      return
    }
    const trimmed = watchedValue.trim()
    if (!trimmed) {
      return
    }
    const parsed = parse(trimmed, valueFormat, new Date())
    return Number.isNaN(parsed.getTime()) ? undefined : parsed
  }, [kind, watchedValue, valueFormat])
  const timePickerBase = useMemo(
    () => pickedDate ?? new Date(new Date().setHours(0, 0, 0, 0)),
    [pickedDate],
  )

  const applyPickedValue = (
    picked: string,
    options?: { keepOpen?: boolean },
  ) => {
    form.setValue(name, picked, { shouldDirty: true, shouldValidate: true })
    setInputKey((current) => current + 1)
    if (!options?.keepOpen) {
      setIsPickerOpen(false)
    }
  }

  // s203: a multiSelect writes the canonical stored text (JSON array in
  // option order, "" for none) so the server normalizer sees no rewrite.
  const pickedOptions = new Set(
    kind === "multiSelect" && typeof watchedValue === "string"
      ? multiSelectItems(watchedValue)
      : [],
  )
  const toggleOption = (option: string, checked: boolean) => {
    if (checked) {
      pickedOptions.add(option)
    } else {
      pickedOptions.delete(option)
    }
    const ordered = options.filter((o) => pickedOptions.has(o))
    applyPickedValue(ordered.length === 0 ? "" : JSON.stringify(ordered), {
      keepOpen: true,
    })
  }

  const applyPickedDate = (picked: Date | undefined) => {
    if (!picked) {
      return
    }
    // Datetime keeps the popover open so the time can still be adjusted.
    // zone: wall-clock (day/time-picker date, local fields in and out)
    applyPickedValue(format(picked, valueFormat), {
      keepOpen: kind === "datetime",
    })
  }

  return (
    <Popover
      onOpenChange={(open) => {
        // Only clicks in the text input open the picker — clicks on inline
        // icons (e.g. the {{variable}} picker) keep their own popover.
        if (open && !isClickInInputRef.current) {
          return
        }
        setIsPickerOpen(open)
      }}
      open={isPickerOpen}
    >
      <PopoverTrigger
        nativeButton={false}
        render={
          <div
            className="w-full"
            onClickCapture={(event) => {
              isClickInInputRef.current = Boolean(
                (event.target as HTMLElement).closest(
                  ".tiptap-plain-text, input, textarea",
                ),
              )
            }}
          >
            {children(inputKey)}
          </div>
        }
      />
      <PopoverContent align="start" className="w-auto max-w-80 p-0">
        {kind === "select" ? (
          <div className="flex max-h-72 flex-col overflow-y-auto p-1">
            {options.map((option) => (
              <Button
                className="min-w-0 justify-start"
                key={option}
                onClick={() => applyPickedValue(option)}
                type="button"
                variant="ghost"
              >
                <span className="truncate">{option}</span>
              </Button>
            ))}
          </div>
        ) : null}
        {kind === "multiSelect" ? (
          <div
            className="flex max-h-72 flex-col gap-2 overflow-y-auto p-3"
            data-testid="multi-select-picker"
          >
            {options.map((option) => (
              // biome-ignore lint/a11y/noLabelWithoutControl: the Checkbox inside is the control
              <label
                className="flex min-w-0 cursor-pointer items-center gap-2 text-sm"
                key={option}
              >
                <Checkbox
                  checked={pickedOptions.has(option)}
                  onCheckedChange={(checked) =>
                    toggleOption(option, checked === true)
                  }
                />
                <span className="truncate" title={option}>
                  {option}
                </span>
              </label>
            ))}
          </div>
        ) : null}
        {kind === "boolean" ? (
          <div className="flex flex-col p-1">
            <Button
              className="justify-start"
              onClick={() => applyPickedValue("true")}
              type="button"
              variant="ghost"
            >
              {t("fields.boolean.true")}
            </Button>
            <Button
              className="justify-start"
              onClick={() => applyPickedValue("false")}
              type="button"
              variant="ghost"
            >
              {t("fields.boolean.false")}
            </Button>
          </div>
        ) : null}
        {kind === "date" || kind === "datetime" ? (
          <>
            <Calendar
              defaultMonth={pickedDate}
              mode="single"
              onSelect={(day) => {
                if (!day) {
                  return
                }
                day.setHours(
                  pickedDate?.getHours() ?? 0,
                  pickedDate?.getMinutes() ?? 0,
                  withSeconds ? (pickedDate?.getSeconds() ?? 0) : 0,
                )
                applyPickedDate(day)
              }}
              selected={pickedDate}
            />
            {kind === "datetime" ? (
              <div className="border-border border-t p-3">
                <TimePicker
                  date={timePickerBase}
                  granularity={withSeconds ? "second" : "minute"}
                  hourCycle={24}
                  onChange={applyPickedDate}
                />
              </div>
            ) : null}
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
