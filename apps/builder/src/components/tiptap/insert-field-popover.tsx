"use client"

import { Button } from "@chatbotx.io/ui/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@chatbotx.io/ui/components/ui/popover"
import type { Editor } from "@tiptap/react"
import { CodeXmlIcon } from "lucide-react"
import { useState } from "react"
import type { PromptVariableOption } from "./extensions/variable-injection/definition"
import { toVariableMentionAttrs } from "./extensions/variable-injection/mention"

/**
 * The "Insert field" popover of the HTML-emitting Tiptap editors (Documents,
 * email templates): grouped `{{variable}}` options, one click inserts the
 * mention chip at the cursor.
 */
export function InsertFieldPopover({
  editor,
  options,
  label,
}: {
  editor: Editor | null
  options: PromptVariableOption[]
  label: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        render={
          <Button size="sm" type="button" variant="ghost">
            <CodeXmlIcon className="me-1 size-4" />
            {label}
          </Button>
        }
      />
      <PopoverContent className="w-60 p-0">
        <div className="max-h-72 overflow-y-auto">
          {options.map((field, index) => (
            <div key={field.value}>
              {field.group && options[index - 1]?.group !== field.group ? (
                <div className="px-2 pt-2 pb-1 font-medium text-muted-foreground text-xs">
                  {field.group}
                </div>
              ) : null}
              <Button
                className="w-full justify-start rounded-none"
                onClick={() => {
                  editor
                    ?.chain()
                    .insertContent({
                      type: "mention",
                      attrs: toVariableMentionAttrs(field),
                    })
                    .focus()
                    .run()
                  setOpen(false)
                }}
                type="button"
                variant="ghost"
              >
                {field.label}
              </Button>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
