// @vitest-environment jsdom
import { renderWeb } from "@chatbotx.io/email-document/render-web"
import { Editor } from "@tiptap/react"
import { expect, test } from "vitest"
import { richTextExtensions } from "@/features/email-templates/components/rich-text-field"

/**
 * s221b: everything the rich-text editor can produce survives the email
 * sanitizer. An offered mark the sanitizer strips would silently vanish from
 * the sent mail.
 */
const editorHtml = (content: string) => {
  const editor = new Editor({ extensions: richTextExtensions, content })
  const html = editor.getHTML()
  editor.destroy()
  return html
}

const render = (text: string) =>
  renderWeb(
    {
      version: 1,
      settings: {},
      blocks: [{ id: "1", type: "text", text }],
    },
    { vars: {}, assets: {} },
  ).html

test("every mark and list the editor offers survives the sanitizer", () => {
  const html = editorHtml(
    '<p><strong>b</strong> <em>i</em> <u>u</u> <s>s</s> <a href="https://x.test/p">link</a></p><ul><li><p>one</p></li></ul><ol><li><p>two</p></li></ol>',
  )
  const out = render(html)
  for (const tag of [
    "<strong>",
    "<em>",
    "<u>",
    "<s>",
    "<ul>",
    "<ol>",
    "<li>",
  ]) {
    expect(out, tag).toContain(tag)
  }
  expect(out).toContain('href="https://x.test/p"')
})

test("the editor itself drops what the sanitizer would strip (headings, quotes, code, hr) and unsafe links", () => {
  const html = editorHtml(
    '<h1>h</h1><blockquote><p>q</p></blockquote><pre><code>c</code></pre><hr><p><a href="javascript:alert(1)">x</a></p>',
  )
  for (const tag of ["<h1", "<blockquote", "<pre", "<code", "<hr"]) {
    expect(html, tag).not.toContain(tag)
  }
  expect(html).not.toContain("javascript:")
})
