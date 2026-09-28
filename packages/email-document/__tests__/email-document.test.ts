import { describe, expect, test } from "vitest"
import {
  DocumentTooLargeError,
  DocumentValidationError,
  type EmailDocument,
  fromLegacyElements,
  parseDocument,
} from "../src"
import { renderEmail } from "../src/render-email"
import { renderWeb } from "../src/render-web"

const SANITIZED_AWAY =
  /<script|onclick|onerror|javascript:|<iframe|<style|position:fixed/i
const INJECTED_MARKUP = /<img|<a href="https:\/\/evil/
const REAL_TAG = /<[a-zA-Z][^>]*>/g
const DANGEROUS_ELEMENT = /^<(script|iframe|svg|style|object|embed)\b/i
const EVENT_HANDLER = /\son[a-z]+\s*=/i
const JS_URL_ATTR = /(href|src|style)\s*=\s*"[^"]*javascript:/i

const LIVE_LINK_OR_IMG = /href="(?!#)|<img/

const doc = (blocks: unknown[], settings: object = {}): EmailDocument =>
  ({ version: 1, settings, blocks }) as EmailDocument

const text = (id: string, html: string) => ({ id, type: "text", text: html })
const ctx = { vars: { first_name: "Ada", site: "https://ada.test/x" } }

describe("parseDocument", () => {
  test("accepts a document with every block type", () => {
    const d = doc([
      { id: "1", type: "heading", level: 1, text: "Hi {{first_name}}" },
      text("2", "<p>Body</p>"),
      { id: "3", type: "image", src: { kind: "media", fileId: "9" }, alt: "a" },
      {
        id: "4",
        type: "button",
        label: "Go",
        action: { kind: "url", url: "https://x.test" },
      },
      { id: "5", type: "divider" },
      { id: "6", type: "spacer", height: 16 },
      { id: "7", type: "html", html: "<table><tr><td>x</td></tr></table>" },
      { id: "8", type: "attachment", asset: { kind: "media", fileId: "10" } },
      { id: "9", type: "code", text: "a < b" },
      {
        id: "10",
        type: "columns",
        columns: [{ blocks: [text("11", "L")] }, { blocks: [text("12", "R")] }],
      },
    ])
    expect(parseDocument(d).blocks).toHaveLength(10)
  })

  test("null, arrays and primitives are refused", () => {
    expect(() => parseDocument(null)).toThrow(DocumentValidationError)
    expect(() => parseDocument("x")).toThrow(DocumentValidationError)
    expect(() => parseDocument(42)).toThrow(DocumentValidationError)
    expect(() => parseDocument([])).toThrow(DocumentValidationError)
  })

  test("CLOSED: an unknown key anywhere is refused, never dropped", () => {
    expect(() =>
      parseDocument({ ...doc([text("1", "x")]), extra: true }),
    ).toThrow(DocumentValidationError)
    expect(() =>
      parseDocument(doc([{ ...text("1", "x"), onclick: "evil()" }])),
    ).toThrow(DocumentValidationError)
    expect(() =>
      parseDocument(doc([text("1", "x")], { theme: "dark" })),
    ).toThrow(DocumentValidationError)
  })

  test("columns inside columns is refused (depth cap by construction)", () => {
    const nested = {
      id: "1",
      type: "columns",
      columns: [
        {
          blocks: [
            {
              id: "2",
              type: "columns",
              columns: [{ blocks: [] }, { blocks: [] }],
            },
          ],
        },
        { blocks: [] },
      ],
    }
    expect(() => parseDocument(doc([nested]))).toThrow(DocumentValidationError)
  })

  test("javascript:, data: and relative links are refused; a single token is allowed", () => {
    const button = (url: string) =>
      doc([
        { id: "1", type: "button", label: "x", action: { kind: "url", url } },
      ])
    expect(() => parseDocument(button("javascript:alert(1)"))).toThrow(
      DocumentValidationError,
    )
    expect(() => parseDocument(button("data:text/html,x"))).toThrow(
      DocumentValidationError,
    )
    expect(() => parseDocument(button("/relative"))).toThrow(
      DocumentValidationError,
    )
    expect(parseDocument(button("{{site}}")).blocks).toHaveLength(1)
    expect(parseDocument(button("mailto:a@b.test")).blocks).toHaveLength(1)
  })

  test("caps: 0 or 201 blocks refused; an oversized payload is DocumentTooLargeError before the schema walk", () => {
    expect(() => parseDocument(doc([]))).toThrow(DocumentValidationError)
    expect(() =>
      parseDocument(
        doc(Array.from({ length: 201 }, (_, i) => text(String(i + 1), "x"))),
      ),
    ).toThrow(DocumentValidationError)
    const huge = doc(
      Array.from({ length: 20 }, (_, i) => ({
        id: String(i + 1),
        type: "html",
        html: "x".repeat(20_000),
      })),
    )
    expect(() => parseDocument(huge)).toThrow(DocumentTooLargeError)
  })
})

describe("renderWeb", () => {
  test("sanitizes: script, handlers, iframes and javascript: hrefs never reach the page", () => {
    const { html } = renderWeb(
      doc([
        text(
          "1",
          '<p onclick="x()">Hi<script>alert(1)</script><a href="javascript:alert(1)">bad</a><iframe src="https://x.test"></iframe><img src=x onerror=alert(1)></p>',
        ),
        {
          id: "2",
          type: "html",
          html: '<div style="color:#ff0000;position:fixed">ok</div><script>x</script><style>*{}</style>',
        },
      ]),
      ctx,
    )
    expect(html).not.toMatch(SANITIZED_AWAY)
    expect(html).toContain("color:#ff0000")
    expect(html).toContain(">Hi")
  })

  test("merge values are HTML-escaped: a contact value can never become markup", () => {
    const { html } = renderWeb(doc([text("1", "<p>Hi {{first_name}}</p>")]), {
      vars: {
        first_name:
          '<img src=x onerror=alert(1)><a href="https://evil.test">x</a>',
      },
    })
    expect(html).not.toMatch(INJECTED_MARKUP)
    expect(html).toContain("&lt;img")
  })

  test("fallbacks render, and every unresolved token is reported in missing", () => {
    const { html, missing } = renderWeb(
      doc([text("1", "<p>{{nick|friend}} {{unknown}}</p>")]),
      { vars: {} },
    )
    expect(html).toContain("friend")
    expect(missing).toEqual(["nick", "unknown"])
  })

  test("a whole-token URL takes the value only when it is http(s)/mailto", () => {
    const button = doc([
      {
        id: "1",
        type: "button",
        label: "Go",
        action: { kind: "url", url: "{{site}}" },
      },
    ])
    expect(renderWeb(button, ctx).html).toContain('href="https://ada.test/x"')
    expect(
      renderWeb(button, { vars: { site: "javascript:alert(1)" } }).html,
    ).not.toContain("javascript:")
  })

  test("a token inside a longer URL is URL-encoded", () => {
    const { html } = renderWeb(
      doc([
        {
          id: "1",
          type: "button",
          label: "Go",
          action: { kind: "url", url: "https://x.test/?n={{first_name}}" },
        },
      ]),
      { vars: { first_name: 'A&"B' } },
    )
    expect(html).toContain("https://x.test/?n=A%26%22B")
  })

  test("link tracking sees template links only, never a merged value", () => {
    const seen: string[] = []
    const link = (url: string) => {
      seen.push(url)
      return `https://hub.test/c?u=${encodeURIComponent(url)}`
    }
    renderWeb(
      doc([
        text(
          "1",
          '<p><a href="https://ours.test/a?x=1&amp;y=2">ours</a> <a href="{{site}}">theirs</a></p>',
        ),
      ]),
      { ...ctx, link },
    )
    expect(seen).toEqual(["https://ours.test/a?x=1&y=2"])
  })

  test("web output carries no pixel and no unsubscribe URL; attachments become download links", () => {
    const { html } = renderWeb(
      doc([
        text("1", '<p><a href="<<unsubscribeUrl>>">stop</a></p>'),
        { id: "2", type: "attachment", asset: { kind: "media", fileId: "5" } },
      ]),
      {
        vars: {},
        unsubscribeUrl: "https://hub.test/unsubscribe?token=t",
        openPixelUrl: "https://hub.test/o",
        assets: {
          "5": {
            url: "https://cdn.test/f.pdf",
            name: "f.pdf",
            size: 10,
            mimeType: "application/pdf",
          },
        },
      },
    )
    expect(html).not.toContain("unsubscribe?token")
    expect(html).not.toContain("hub.test/o")
    expect(html).toContain('href="https://cdn.test/f.pdf"')
  })

  test("a contact value containing the unsubscribe sentinel stays inert text", async () => {
    const out = await renderEmail(doc([text("1", "<p>{{first_name}}</p>")]), {
      vars: { first_name: "__UNSUBSCRIBE_URL__" },
      unsubscribeUrl: "https://hub.test/unsubscribe?token=secret",
    })
    expect(out.html).not.toContain("token=secret")
  })

  test("an asset URL that is not http(s) never reaches href/src (skeptic HIGH)", () => {
    for (const url of [
      "javascript:alert(1)",
      " JAVASCRIPT:x",
      "data:text/html,x",
      "//evil.test/a",
    ]) {
      const { html, missing } = renderWeb(
        doc([
          {
            id: "1",
            type: "attachment",
            asset: { kind: "media", fileId: "9" },
          },
          {
            id: "2",
            type: "image",
            src: { kind: "media", fileId: "9" },
            alt: "x",
          },
        ]),
        {
          vars: {},
          assets: {
            "9": { url, name: "evil", size: 1, mimeType: "text/html" },
          },
        },
      )
      expect(executableMarkup(html)).toEqual([])
      expect(html).not.toMatch(LIVE_LINK_OR_IMG)
      expect(missing).toEqual(["asset:9"])
    }
  })

  test("deterministic: same input, same bytes", () => {
    const d = doc([
      text("1", "<p>Hi {{first_name}}</p>"),
      { id: "2", type: "divider" },
    ])
    expect(renderWeb(d, ctx).html).toBe(renderWeb(d, ctx).html)
  })

  test("an unresolved asset is reported, never an empty <img>", () => {
    const { html, missing } = renderWeb(
      doc([
        {
          id: "1",
          type: "image",
          src: { kind: "media", fileId: "77" },
          alt: "",
        },
      ]),
      { vars: {} },
    )
    expect(html).not.toContain("<img")
    expect(missing).toEqual(["asset:77"])
  })
})

describe("renderEmail", () => {
  test("renders MJML to HTML with a text part, pixel, unsubscribe and attachments", async () => {
    const out = await renderEmail(
      doc(
        [
          { id: "1", type: "heading", level: 1, text: "Hi {{first_name}}" },
          text(
            "2",
            '<p>Read <a href="https://x.test/a">this</a>. <a href="<<unsubscribeUrl>>">Stop</a></p>',
          ),
          {
            id: "3",
            type: "button",
            label: "Pay",
            action: {
              kind: "flow",
              beforeStep: { stepType: "startAnotherNode" },
              steps: [],
            },
          },
          {
            id: "4",
            type: "attachment",
            asset: { kind: "media", fileId: "5" },
          },
          {
            id: "5",
            type: "columns",
            columns: [
              { blocks: [text("6", "L")] },
              { blocks: [text("7", "R")] },
            ],
          },
        ],
        { preheader: "Hello {{first_name}}" },
      ),
      {
        vars: { first_name: "Ada" },
        unsubscribeUrl: "https://hub.test/unsubscribe?token=t",
        openPixelUrl: "https://hub.test/o?r=1",
        button: (id) => `https://hub.test/b/${id}`,
      },
    )
    expect(out.html).toContain("Hi Ada")
    expect(out.html).toContain("https://hub.test/unsubscribe?token=t")
    expect(out.html).toContain("https://hub.test/o?r=1")
    expect(out.html).toContain("https://hub.test/b/3")
    expect(out.text).toContain("Hi Ada")
    expect(out.text).toContain("this [https://x.test/a]")
    expect(out.text).not.toContain("<")
    expect(out.attachments).toEqual([{ kind: "media", fileId: "5" }])
    expect(out.missing).toEqual([])
  })

  test("a flow button without a button() resolver is dropped, not rendered as a dead link", async () => {
    const out = await renderEmail(
      doc([
        {
          id: "1",
          type: "button",
          label: "Pay",
          action: { kind: "flow", beforeStep: {}, steps: [] },
        },
      ]),
      { vars: {} },
    )
    expect(out.html).not.toContain(">Pay<")
  })

  test("hostile nesting in an html block never crashes the text part", async () => {
    const deep = `${"<div>".repeat(3000)}x${"</div>".repeat(3000)}`
    await expect(
      renderEmail(doc([{ id: "1", type: "html", html: deep }]), { vars: {} }),
    ).resolves.toBeTruthy()
  })
})

describe("fromLegacyElements", () => {
  test("converts today's email step elements and drops what it cannot express", () => {
    const d = fromLegacyElements(
      [
        { id: "11", type: "heading", text: "Hello" },
        { id: "12", type: "text", text: "<p>Body</p>" },
        { id: "13", type: "image", url: "https://x.test/i.png" },
        { id: "14", type: "image" },
        { id: "15", type: "line" },
        { id: "16", type: "spacing" },
        {
          id: "17",
          type: "button",
          label: "Go",
          buttonType: "openWebsite",
          beforeStep: { stepType: "openWebsite", url: "https://x.test" },
          steps: [],
        },
        {
          id: "18",
          type: "button",
          label: "Dead",
          buttonType: null,
          beforeStep: null,
          steps: [],
        },
        { id: "19", type: "mystery" },
      ],
      { preheader: "p" },
    )
    expect(parseDocument(d).blocks.map((b) => b.type)).toEqual([
      "heading",
      "text",
      "image",
      "divider",
      "spacer",
      "button",
    ])
    expect(d.settings.preheader).toBe("p")
  })

  test("null, non-array and empty input give a valid one-block document", () => {
    for (const input of [null, "x", {}, []]) {
      expect(parseDocument(fromLegacyElements(input)).blocks).toHaveLength(1)
    }
  })
})

/**
 * Structural oracle: inspects REAL tags only (escaped text like `&lt;img` is
 * inert and must not count): no dangerous element, no event-handler
 * attribute, no javascript: in href/src/style.
 */
function executableMarkup(html: string): string[] {
  const found: string[] = []
  for (const [tag] of html.matchAll(REAL_TAG)) {
    if (DANGEROUS_ELEMENT.test(tag)) {
      found.push(tag)
    }
    if (EVENT_HANDLER.test(tag)) {
      found.push(tag)
    }
    if (JS_URL_ATTR.test(tag)) {
      found.push(tag)
    }
  }
  return found
}

describe("fuzz: renderWeb never emits executable markup", () => {
  test("the oracle itself catches real markup and ignores escaped text", () => {
    expect(executableMarkup('<img src="x" onerror="a()">')).toHaveLength(1)
    expect(executableMarkup('<a href="javascript:x">')).toHaveLength(1)
    expect(executableMarkup("<script>")).toHaveLength(1)
    expect(executableMarkup("&lt;img src=x onerror=a()&gt;")).toEqual([])
  })

  const PIECES = [
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    '<a href="javascript:alert(1)">x</a>',
    '<a href="JaVaScRiPt:alert(1)">x</a>',
    "<svg onload=alert(1)>",
    '<div style="background:url(javascript:alert(1))">',
    "<iframe src=//evil.test>",
    "{{first_name}}",
    "{{x|<b>}}",
    "<<unsubscribeUrl>>",
    "<p>plain</p>",
    '"><script>',
    "&lt;script&gt;",
  ]
  test("500 random rich/html documents with hostile values", () => {
    let seed = 1
    const rand = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed / 2_147_483_648
    }
    const pick = () => PIECES[Math.floor(rand() * PIECES.length)] as string
    for (let round = 0; round < 500; round += 1) {
      const body = Array.from({ length: 6 }, pick).join("")
      const d = doc([
        text("1", body),
        { id: "2", type: "html", html: body },
        { id: "3", type: "code", text: body },
      ])
      const { html } = renderWeb(d, { vars: { first_name: pick(), x: pick() } })
      expect(executableMarkup(html)).toEqual([])
    }
  })
})
