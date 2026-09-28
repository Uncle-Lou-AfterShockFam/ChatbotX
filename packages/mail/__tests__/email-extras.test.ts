import { describe, expect, test } from "vitest"
import {
  extractHttpHrefs,
  htmlToPlainText,
  renderDynamicEmailText,
  rewriteHtmlLinks,
} from "../src/email-extras"

const track = async (url: string) =>
  `https://hub.test/c?u=${encodeURIComponent(url)}`

describe("htmlToPlainText", () => {
  test("block tags become breaks, links keep their URL, entities decode", () => {
    expect(
      htmlToPlainText(
        '<p>Hi &amp; welcome</p><p>Read <a href="https://x.test/a">this</a><br>now</p><ul><li>one</li><li>two</li></ul>',
      ),
    ).toBe(
      "Hi & welcome\n\nRead this [https://x.test/a]\nnow\n\n * one\n * two",
    )
  })

  test("a bare link whose label is the URL prints once", () => {
    expect(htmlToPlainText('<a href="https://x.test">https://x.test</a>')).toBe(
      "https://x.test",
    )
  })

  test("hostile nesting (depth 10000) never throws (s220b probe)", () => {
    const deep = `${"<b>".repeat(10_000)}x${"</b>".repeat(10_000)}`
    expect(() => htmlToPlainText(deep)).not.toThrow()
    expect(() =>
      renderDynamicEmailText([{ type: "text", text: deep }]),
    ).not.toThrow()
  })

  test("empty, null and non-string input give an empty string", () => {
    expect(htmlToPlainText("")).toBe("")
    expect(htmlToPlainText(null as unknown as string)).toBe("")
    expect(htmlToPlainText(42 as unknown as string)).toBe("")
  })
})

describe("renderDynamicEmailText", () => {
  test("drops images and the pixel, keeps text, code and buttons", () => {
    expect(
      renderDynamicEmailText([
        { type: "heading", text: "<b>Hello</b>" },
        { type: "image", url: "https://x.test/pixel" },
        { type: "text", text: "<p>Body</p>" },
        { type: "code", text: "<raw>" },
        { type: "line" },
        { type: "button", label: "Pay", url: "https://x.test/pay" },
        { type: "button", label: "No url" },
        { type: "spacing" },
      ]),
    ).toBe("Hello\n\nBody\n\n<raw>\n\n----\n\nPay: https://x.test/pay")
  })

  test("non-array input gives an empty string", () => {
    expect(renderDynamicEmailText(null as never)).toBe("")
  })
})

describe("rewriteHtmlLinks", () => {
  test("rewrites http(s) links and leaves mailto, tel and kept URLs", async () => {
    const html =
      '<a href="https://x.test/a?b=1&amp;c=2">a</a> <a href="mailto:x@y.test">m</a> <a href="tel:+1555">t</a> <a class="k" href="https://hub.test/unsubscribe?token=T">u</a>'
    const out = await rewriteHtmlLinks(
      html,
      track,
      new Set(extractHttpHrefs(html).filter((h) => !h.includes("unsubscribe"))),
    )
    expect(out).toBe(
      '<a href="https://hub.test/c?u=https%3A%2F%2Fx.test%2Fa%3Fb%3D1%26c%3D2">a</a> <a href="mailto:x@y.test">m</a> <a href="tel:+1555">t</a> <a class="k" href="https://hub.test/unsubscribe?token=T">u</a>',
    )
  })

  test("javascript: and relative hrefs are never rewritten", async () => {
    const html = '<a href="javascript:alert(1)">x</a><a href="/p">y</a>'
    expect(await rewriteHtmlLinks(html, track, new Set(["/p"]))).toBe(html)
  })

  test("html without links is returned unchanged; empty input gives empty", async () => {
    const any = new Set(["https://x.test"])
    expect(await rewriteHtmlLinks("<p>plain</p>", track, any)).toBe(
      "<p>plain</p>",
    )
    expect(await rewriteHtmlLinks("", track, any)).toBe("")
    expect(await rewriteHtmlLinks(null as unknown as string, track, any)).toBe(
      "",
    )
  })

  test("a rewritten URL with quotes or ampersands cannot break out of the attribute", async () => {
    const out = await rewriteHtmlLinks(
      '<a href="https://x.test">x</a>',
      async () => 'https://e.test/?a=1&b="><script>',
      new Set(["https://x.test"]),
    )
    expect(out).toBe(
      '<a href="https://e.test/?a=1&amp;b=&quot;><script>">x</a>',
    )
  })

  test("stress: every http anchor in random markup is rewritten exactly once", async () => {
    let seed = 7
    const rand = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed / 2_147_483_648
    }
    for (let round = 0; round < 200; round += 1) {
      const parts: string[] = []
      let expected = 0
      for (let i = 0; i < 30; i += 1) {
        const r = rand()
        if (r < 0.3) {
          parts.push(`<a href="https://s${i}.test/${round}">l</a>`)
          expected += 1
        } else if (r < 0.4) {
          parts.push(`<a href="mailto:m${i}@x.test">m</a>`)
        } else if (r < 0.5) {
          parts.push("<a>no href</a>")
        } else {
          parts.push(`<p>t${i} &amp; "q"</p>`)
        }
      }
      let calls = 0
      const html = parts.join("")
      const out = await rewriteHtmlLinks(
        html,
        (url) => {
          calls += 1
          return Promise.resolve(
            `https://hub.test/c?u=${encodeURIComponent(url)}`,
          )
        },
        new Set(extractHttpHrefs(html)),
      )
      expect(calls).toBe(expected)
      expect(out.match(/https:\/\/hub\.test\/c\?u=/g)?.length ?? 0).toBe(
        expected,
      )
    }
  })
})

describe("rewriteHtmlLinks: only template links are signed (s220b skeptic CRITICAL)", () => {
  test("a link injected through a merge field is left untracked", async () => {
    const template =
      '<p>Hi {{first_name}}, see <a href="https://ours.test/offer">offer</a></p>'
    const merged = template.replace(
      "{{first_name}}",
      '<a href="https://phish.test/steal">Verify now</a>',
    )
    const out = await rewriteHtmlLinks(
      merged,
      track,
      new Set(extractHttpHrefs(template)),
    )
    expect(out).toContain('href="https://phish.test/steal"')
    expect(out).toContain(
      'href="https://hub.test/c?u=https%3A%2F%2Fours.test%2Foffer"',
    )
  })

  test("an empty allow-set rewrites nothing", async () => {
    const html = '<a href="https://x.test">x</a>'
    expect(await rewriteHtmlLinks(html, track, new Set())).toBe(html)
  })

  test("past the anchor cap the fragment is returned unchanged", async () => {
    const html = '<a href="https://x.test">x</a>'.repeat(201)
    expect(
      await rewriteHtmlLinks(html, track, new Set(["https://x.test"])),
    ).toBe(html)
  })

  test("past the size cap the fragment is returned unchanged", async () => {
    const html = `<a href="https://x.test">x</a>${"y".repeat(200_001)}`
    expect(
      await rewriteHtmlLinks(html, track, new Set(["https://x.test"])),
    ).toBe(html)
  })
})

describe("extractHttpHrefs", () => {
  test("returns decoded http(s) hrefs only; bad input gives []", () => {
    expect(
      extractHttpHrefs(
        '<a href="https://a.test/?x=1&amp;y=2">a</a><a href="mailto:m@x.test">m</a><a href="{{url}}">v</a>',
      ),
    ).toEqual(["https://a.test/?x=1&y=2"])
    expect(extractHttpHrefs(null as unknown as string)).toEqual([])
  })
})
