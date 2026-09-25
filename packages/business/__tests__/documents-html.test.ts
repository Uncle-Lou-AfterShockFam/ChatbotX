import { describe, expect, test } from "vitest"
import {
  DocumentMergeError,
  documentVariables,
  escapeHtml,
  MAX_MERGE_VALUE_LENGTH,
  mergeDocumentHtml,
  wrapDocumentHtml,
} from "../src/documents/html"

const REMOTE_URL_RE = /https?:\/\//
const BR_RE = /<br>/g
const RAW_MARKUP_RE = /[<>"']/
const BRACES_RE = /\{\{|\}\}/

const BODY =
  '<p>Hi {{first_name}}, record {{ user_id }}.</p><p><span class="doc-ph-sig">{{signature, r1}}</span> {{date, r1}} {{unknown_field}}</p>'

describe("documents html", () => {
  test("documentVariables lists every placeholder key once, trimmed", () => {
    expect(documentVariables(`${BODY} {{first_name}}`)).toEqual([
      "first_name",
      "user_id",
      "signature, r1",
      "date, r1",
      "unknown_field",
    ])
  })

  test("merge escapes values, keeps unknown and Documenso placeholders as written", () => {
    const out = mergeDocumentHtml(BODY, {
      first_name: `<script>x</script> & "Ada" 'L'`,
      user_id: "11702341840011264",
    })
    expect(out).toContain(
      "Hi &lt;script&gt;x&lt;/script&gt; &amp; &quot;Ada&quot; &#39;L&#39;, record 11702341840011264.",
    )
    expect(out).toContain("{{signature, r1}}")
    expect(out).toContain("{{date, r1}}")
    expect(out).toContain("{{unknown_field}}")
  })

  test("adjacent values can never assemble a signing field: any single brace is refused", () => {
    expect(() =>
      mergeDocumentHtml("{{a}}{{b}}{{c}}", {
        a: "{",
        b: "signature, r2",
        c: "}",
      }),
    ).toThrow(DocumentMergeError)
    expect(() =>
      mergeDocumentHtml("{{a}}{{b}}", { a: "x", b: "{date, r1}" }),
    ).toThrow(DocumentMergeError)
  })

  test("the rendered page carries a CSP that loads and runs nothing", () => {
    expect(wrapDocumentHtml("T", "<p>x</p>")).toContain(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">`,
    )
  })

  test("a value can never plant a Documenso field; control chars and oversize are refused", () => {
    for (const bad of [
      "{{signature, r2}}",
      "a{{b",
      "b}}a",
      "nul\u0000",
      "bell\u0007",
      "x".repeat(MAX_MERGE_VALUE_LENGTH + 1),
    ]) {
      expect(() => mergeDocumentHtml(BODY, { first_name: bad })).toThrow(
        DocumentMergeError,
      )
    }
    expect(
      mergeDocumentHtml(BODY, {
        first_name: "x".repeat(MAX_MERGE_VALUE_LENGTH),
      }),
    ).toContain("x".repeat(100))
  })

  test("newlines in a value become <br>; prototype keys are not merge values", () => {
    expect(
      mergeDocumentHtml("<p>{{addr}}</p>", { addr: "1 Main\nApt 2" }),
    ).toBe("<p>1 Main<br>Apt 2</p>")
    expect(mergeDocumentHtml("<p>{{constructor}} {{__proto__}}</p>", {})).toBe(
      "<p>{{constructor}} {{__proto__}}</p>",
    )
  })

  test("signing placeholders are sized; merge chips and other braces are not", () => {
    const html = wrapDocumentHtml(
      "T",
      "<p>Sign: {{signature, r1}} on {{ DATE , r2 }}</p><p>{{first_name}}</p>",
    )
    expect(html).toContain('<span class="doc-ph-sig">{{signature, r1}}</span>')
    expect(html).toContain('<span class="doc-ph-date">{{ DATE , r2 }}</span>')
    expect(html).toContain("<p>{{first_name}}</p>")
  })

  test("wrap escapes the title and stays self-contained (no remote resources)", () => {
    const html = wrapDocumentHtml("A <b> & c", "<p>x</p>")
    expect(html).toContain("<title>A &lt;b&gt; &amp; c</title>")
    expect(html).not.toMatch(REMOTE_URL_RE)
    expect(escapeHtml("<>&\"'")).toBe("&lt;&gt;&amp;&quot;&#39;")
  })

  test("fuzz: a merged value is escaped or refused, never raw markup or braces", () => {
    const alphabet = [
      "a",
      "<",
      ">",
      "&",
      '"',
      "'",
      "{",
      "}",
      " ",
      "\n",
      "é",
      "0",
    ]
    let merged = 0
    for (let i = 0; i < 500; i++) {
      const v = Array.from(
        { length: Math.floor(Math.random() * 10) },
        () => alphabet[Math.floor(Math.random() * alphabet.length)],
      ).join("")
      let out: string
      try {
        out = mergeDocumentHtml("<i>{{v}}</i>", { v })
      } catch (err) {
        expect(err).toBeInstanceOf(DocumentMergeError)
        continue
      }
      merged++
      const inner = out.slice(3, -4)
      expect(inner.replace(BR_RE, "")).not.toMatch(RAW_MARKUP_RE)
      expect(inner).not.toMatch(BRACES_RE)
    }
    expect(merged).toBeGreaterThan(50)
  })
})
