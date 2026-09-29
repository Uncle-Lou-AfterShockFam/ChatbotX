"use client"

import { Button } from "@chatbotx.io/ui/components/ui/button"
import { Input } from "@chatbotx.io/ui/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@chatbotx.io/ui/components/ui/popover"
import Mention from "@tiptap/extension-mention"
import { EditorContent, useEditor } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import {
  BoldIcon,
  CodeXmlIcon,
  ItalicIcon,
  LinkIcon,
  ListIcon,
  ListOrderedIcon,
  UnderlineIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { useEffect, useRef, useState } from "react"
import {
  renderVariableMentionHTML,
  renderVariableMentionText,
  toVariableMentionAttrs,
} from "@/components/tiptap/extensions/variable-injection/mention"
import variableInjectionSuggestion from "@/components/tiptap/extensions/variable-injection/suggestion"
import { usePromptVariableOptions } from "@/components/tiptap/use-prompt-variable-options"
import "@/components/tiptap/tiptap-editor.css"

/** Link schemes the document schema and the sanitizer accept. */
const SAFE_LINK = /^(https?:\/\/|mailto:)/i

/**
 * The only StarterKit nodes/marks the email sanitizer keeps (p br strong em u
 * s a ul ol li): anything else would be stripped at render, so it is not
 * offered. Headings are a block type of their own (level on the block).
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
  const [variablesOpen, setVariablesOpen] = useState(false)
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkUrl, setLinkUrl] = useState("")
  const options = usePromptVariableOptions({})
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
        <Popover onOpenChange={setVariablesOpen} open={variablesOpen}>
          <PopoverTrigger
            render={
              <Button size="sm" type="button" variant="ghost">
                <CodeXmlIcon className="me-1 size-4" />
                {t("insertField")}
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
                      setVariablesOpen(false)
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
      </div>
      <EditorContent editor={editor} />
    </div>
  )
}
