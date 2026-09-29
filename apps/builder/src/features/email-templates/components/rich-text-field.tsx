"use client"

import { Button } from "@chatbotx.io/ui/components/ui/button"
import { Input } from "@chatbotx.io/ui/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@chatbotx.io/ui/components/ui/popover"
import Mention from "@tiptap/extension-mention"
import { Color, TextStyle } from "@tiptap/extension-text-style"
import { EditorContent, useEditor } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import {
  BoldIcon,
  ItalicIcon,
  LinkIcon,
  ListIcon,
  ListOrderedIcon,
  PaletteIcon,
  UnderlineIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { useEffect, useRef, useState } from "react"
import {
  renderVariableMentionHTML,
  renderVariableMentionText,
} from "@/components/tiptap/extensions/variable-injection/mention"
import variableInjectionSuggestion from "@/components/tiptap/extensions/variable-injection/suggestion"
import { InsertFieldPopover } from "@/components/tiptap/insert-field-popover"
import { usePromptVariableOptions } from "@/components/tiptap/use-prompt-variable-options"
import "@/components/tiptap/tiptap-editor.css"

/** Link schemes the document schema and the sanitizer accept. */
const SAFE_LINK = /^(https?:\/\/|mailto:)/i

/** The only text colors the sanitizer keeps (`COLOR_ONLY`): `#rrggbb`. */
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/
const DEFAULT_TEXT_COLOR = "#111111"
const RGB_COLOR = /^rgb\(\s*(\d{1,3}),\s*(\d{1,3}),\s*(\d{1,3})\s*\)$/

/** A stored color as `#rrggbb` for the picker (the DOM may hand back rgb()). */
export function toHexColor(color: string): string | null {
  if (HEX_COLOR.test(color)) {
    return color.toLowerCase()
  }
  const rgb = RGB_COLOR.exec(color)
  if (!rgb) {
    return null
  }
  const parts = rgb.slice(1, 4).map(Number)
  if (parts.some((n) => n > 255)) {
    return null
  }
  return `#${parts.map((n) => n.toString(16).padStart(2, "0")).join("")}`
}

/**
 * The only StarterKit nodes/marks the email sanitizer keeps (p br strong em u
 * s a ul ol li), plus a `span style="color:#rrggbb"` from TextStyle + Color:
 * anything else would be stripped at render, so it is not offered. Headings
 * are a block type of their own (level on the block).
 */
export const richTextExtensions = [
  StarterKit.configure({
    blockquote: false,
    code: false,
    codeBlock: false,
    horizontalRule: false,
    heading: false,
    link: {
      openOnClick: false,
      protocols: ["http", "https", "mailto"],
      isAllowedUri: (url) => SAFE_LINK.test(url),
    },
  }),
  TextStyle,
  Color,
]

/**
 * Rich text for a heading/text block: Tiptap emitting the allowlisted HTML,
 * with the builder's `{{variable}}` chips. Coupon and bot-field chips are not
 * offered (their HTML shows a label, not the token), as in the Documents
 * editor.
 */
export function RichTextField({
  value,
  onChange,
  minimal = false,
  testId,
}: {
  value: string
  onChange: (html: string) => void
  /** Headings: marks only, no lists. */
  minimal?: boolean
  testId?: string
}) {
  const t = useTranslations("emailTemplates.editor")
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkUrl, setLinkUrl] = useState("")
  const options = usePromptVariableOptions({ includeFormLinkVariables: true })
  const optionsRef = useRef(options)
  useEffect(() => {
    optionsRef.current = options
  }, [options])

  const editor = useEditor({
    extensions: [
      ...richTextExtensions,
      Mention.configure({
        renderHTML: renderVariableMentionHTML,
        renderText: renderVariableMentionText,
        suggestion: variableInjectionSuggestion({
          listOfPromptVariables: () => optionsRef.current,
        }),
      }),
    ],
    content: value,
    immediatelyRender: false,
    onUpdate: ({ editor: e }) => onChange(e.getHTML()),
    editorProps: {
      attributes: {
        class:
          "prose prose-sm min-h-[80px] max-w-none rounded-md border bg-background p-3 focus:outline-none",
        ...(testId ? { "data-testid": testId } : {}),
      },
    },
  })

  const marks = [
    {
      key: "bold",
      icon: BoldIcon,
      run: () => editor?.chain().focus().toggleBold().run(),
      active: editor?.isActive("bold"),
    },
    {
      key: "italic",
      icon: ItalicIcon,
      run: () => editor?.chain().focus().toggleItalic().run(),
      active: editor?.isActive("italic"),
    },
    {
      key: "underline",
      icon: UnderlineIcon,
      run: () => editor?.chain().focus().toggleUnderline().run(),
      active: editor?.isActive("underline"),
    },
    ...(minimal
      ? []
      : [
          {
            key: "bulletList",
            icon: ListIcon,
            run: () => editor?.chain().focus().toggleBulletList().run(),
            active: editor?.isActive("bulletList"),
          },
          {
            key: "orderedList",
            icon: ListOrderedIcon,
            run: () => editor?.chain().focus().toggleOrderedList().run(),
            active: editor?.isActive("orderedList"),
          },
        ]),
  ] as const

  const applyLink = () => {
    const url = linkUrl.trim()
    if (url === "") {
      editor?.chain().focus().unsetLink().run()
    } else if (SAFE_LINK.test(url)) {
      editor
        ?.chain()
        .focus()
        .extendMarkRange("link")
        .setLink({ href: url })
        .run()
    }
    setLinkOpen(false)
  }

  const activeColor = String(editor?.getAttributes("textStyle").color ?? "")
  const activeHex = toHexColor(activeColor)
  const applyColor = (color: string) => {
    if (HEX_COLOR.test(color)) {
      editor?.chain().setColor(color.toLowerCase()).run()
    }
  }

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1">
        {marks.map((mark) => (
          <Button
            aria-label={t(`toolbar.${mark.key}`)}
            key={mark.key}
            onClick={mark.run}
            size="icon"
            type="button"
            variant={mark.active ? "secondary" : "ghost"}
          >
            <mark.icon className="size-4" />
          </Button>
        ))}
        <Popover
          onOpenChange={(open) => {
            setLinkOpen(open)
            if (open) {
              setLinkUrl(String(editor?.getAttributes("link").href ?? ""))
            }
          }}
          open={linkOpen}
        >
          <PopoverTrigger
            render={
              <Button
                aria-label={t("toolbar.link")}
                size="icon"
                type="button"
                variant={editor?.isActive("link") ? "secondary" : "ghost"}
              >
                <LinkIcon className="size-4" />
              </Button>
            }
          />
          <PopoverContent className="w-72 space-y-2 p-3">
            <Input
              aria-label={t("toolbar.link")}
              onChange={(e) => setLinkUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  applyLink()
                }
              }}
              placeholder="https://"
              value={linkUrl}
            />
            {linkUrl.trim() !== "" && !SAFE_LINK.test(linkUrl.trim()) ? (
              <p className="text-destructive text-xs">{t("linkInvalid")}</p>
            ) : null}
            <Button onClick={applyLink} size="sm" type="button">
              {t("apply")}
            </Button>
          </PopoverContent>
        </Popover>
        <label
          className="relative inline-flex size-9 cursor-pointer items-center justify-center rounded-md hover:bg-accent"
          title={t("toolbar.color")}
        >
          <PaletteIcon
            className="size-4"
            style={activeHex ? { color: activeHex } : {}}
          />
          <input
            aria-label={t("toolbar.color")}
            className="absolute inset-0 cursor-pointer opacity-0"
            data-testid={testId ? `${testId}-color` : undefined}
            onChange={(e) => applyColor(e.target.value)}
            type="color"
            value={activeHex ?? DEFAULT_TEXT_COLOR}
          />
        </label>
        {activeColor === "" ? null : (
          <Button
            onClick={() => editor?.chain().focus().unsetColor().run()}
            size="sm"
            type="button"
            variant="ghost"
          >
            {t("toolbar.clearColor")}
          </Button>
        )}
        <InsertFieldPopover
          editor={editor}
          label={t("insertField")}
          options={options}
        />
      </div>
      <EditorContent editor={editor} />
    </div>
  )
}
