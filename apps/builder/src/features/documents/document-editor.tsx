"use client"

import { Button } from "@chatbotx.io/ui/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@chatbotx.io/ui/components/ui/popover"
import Mention from "@tiptap/extension-mention"
import Placeholder from "@tiptap/extension-placeholder"
import { EditorContent, useEditor } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import {
  BoldIcon,
  CodeXmlIcon,
  Heading1Icon,
  Heading2Icon,
  ItalicIcon,
  ListIcon,
  ListOrderedIcon,
  PenLineIcon,
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

/**
 * The document template editor (roadmap B3): Tiptap with headings, lists and
 * the builder's `{{variable}}` chips, emitting HTML (the message editor
 * emits plain text). Coupon and bot-field chips are left out: their HTML shows
 * a label, not the token, so a document could not resolve them. The signature
 * block inserts the Documenso placeholders as plain text; the renderer sizes
 * them (`sizeSigningPlaceholders`).
 */
const toolLabelKey = {
  bold: "toolbar.bold",
  italic: "toolbar.italic",
  heading1: "toolbar.heading1",
  heading2: "toolbar.heading2",
  bulletList: "toolbar.bulletList",
  orderedList: "toolbar.orderedList",
} as const

const escapeText = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/** The signing block: two labelled lines carrying the Documenso placeholders. */
export const signatureBlockHtml = (signatureLabel: string, dateLabel: string) =>
  `<p>${escapeText(signatureLabel)}: {{signature, r1}}</p><p>${escapeText(dateLabel)}: {{date, r1}}</p>`

export function DocumentEditor({
  initialHtml,
  onChange,
}: {
  initialHtml: string
  onChange: (html: string) => void
}) {
  const t = useTranslations("documents")
  const [variablesOpen, setVariablesOpen] = useState(false)
  const options = usePromptVariableOptions({})
  const optionsRef = useRef(options)
  useEffect(() => {
    optionsRef.current = options
  }, [options])

  const editor = useEditor({
    extensions: [
      StarterKit,
      Mention.configure({
        renderHTML: renderVariableMentionHTML,
        renderText: renderVariableMentionText,
        suggestion: variableInjectionSuggestion({
          listOfPromptVariables: () => optionsRef.current,
        }),
      }),
      Placeholder.configure({ placeholder: t("editorPlaceholder") }),
    ],
    content: initialHtml,
    immediatelyRender: false,
    onUpdate: ({ editor: e }) => onChange(e.getHTML()),
    editorProps: {
      attributes: {
        class:
          "prose prose-sm min-h-[420px] max-w-none rounded-md border bg-background p-4 focus:outline-none",
        "data-testid": "document-editor",
      },
    },
  })

  const tools = [
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
      key: "heading1",
      icon: Heading1Icon,
      run: () => editor?.chain().focus().toggleHeading({ level: 1 }).run(),
      active: editor?.isActive("heading", { level: 1 }),
    },
    {
      key: "heading2",
      icon: Heading2Icon,
      run: () => editor?.chain().focus().toggleHeading({ level: 2 }).run(),
      active: editor?.isActive("heading", { level: 2 }),
    },
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
  ] as const

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1">
        {tools.map((tool) => (
          <Button
            aria-label={t(toolLabelKey[tool.key])}
            key={tool.key}
            onClick={tool.run}
            size="icon"
            type="button"
            variant={tool.active ? "secondary" : "ghost"}
          >
            <tool.icon className="size-4" />
          </Button>
        ))}
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
        <Button
          data-testid="document-insert-signature"
          onClick={() =>
            editor
              ?.chain()
              .focus()
              .insertContent(
                signatureBlockHtml(t("signatureLabel"), t("dateSignedLabel")),
              )
              .run()
          }
          size="sm"
          type="button"
          variant="ghost"
        >
          <PenLineIcon className="me-1 size-4" />
          {t("insertSignature")}
        </Button>
      </div>
      <EditorContent editor={editor} />
      <p className="text-muted-foreground text-xs">{t("signatureHint")}</p>
    </div>
  )
}
