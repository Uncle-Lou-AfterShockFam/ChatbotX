import { describe, expect, test } from "vitest"
import {
  collectRenderInputs,
  type EmailDocument,
  mergePlain,
  TEMPLATE_MAX_BYTES,
  TEMPLATE_MAX_DEPTH,
  TemplateError,
  templateError,
  tokenNames,
} from "../src"
import { renderTemplate } from "../src/liquid"
import { renderEmail } from "../src/render-email"
import { mergeHtml, mergeText, mergeUrl } from "../src/tokens"

// s227b outreach B-1 H3: Liquid is the one email evaluator.
const NOT_CLOSED = /not closed/
const NESTS_TOO_DEEP = /nests more than/
const OWNER =
  "Hi {% if first_name %}{{first_name}}{% else %}{{company}} Team{% endif %},"

const html = (text: string, vars: Record<string, string>) => {
  const missing = new Set<string>()
  return { out: mergeText(text, vars, missing), missing: [...missing].sort() }
}

describe("owner example (ManyReach syntax)", () => {
  test("renders the if branch when the field is set", () => {
    expect(html(OWNER, { first_name: "Ada", company: "Acme" }).out).toBe(
      "Hi Ada,",
    )
  })

  test("renders the else branch when the field is missing", () => {
    expect(html(OWNER, { company: "Acme" }).out).toBe("Hi Acme Team,")
  })

  test("an EMPTY value is missing (Liquid alone treats '' as truthy)", () => {
    const { out, missing } = html(OWNER, { first_name: "", company: "Acme" })
    expect(out).toBe("Hi Acme Team,")
    expect(missing).toEqual(["first_name"])
  })

  test("default filter is a fallback", () => {
    expect(html('{{ first_name | default: "there" }}', {}).out).toBe("there")
  })

  test("the subject path (plain text) renders the same branches, unescaped", () => {
    const missing = new Set<string>()
    expect(mergePlain(OWNER, { company: "A&B" }, missing)).toBe("Hi A&B Team,")
    expect(mergePlain(OWNER, { first_name: "Ada" }, missing)).toBe("Hi Ada,")
  })
})

describe("legacy grammar keeps rendering", () => {
  test("{{name|fallback}} with a missing and a present name", () => {
    expect(html("Hi {{first_name|there}}", {}).out).toBe("Hi there")
    expect(html("Hi {{first_name|there}}", { first_name: "Ada" }).out).toBe(
      "Hi Ada",
    )
  })

  test("names Liquid cannot spell resolve as before", () => {
    const vars = {
      "coupon:SUMMER": "SAVE10",
      "bot_field:12": "x",
      "raw:y": "r",
      "favourite colour": "red",
    }
    expect(
      html(
        "{{coupon:SUMMER}} {{bot_field:12}} {{raw:y}} {{favourite colour}}",
        vars,
      ).out,
    ).toBe("SAVE10 x r red")
    expect(
      tokenNames("{{coupon:SUMMER}} {{favourite colour|none}}").sort(),
    ).toEqual(["coupon:SUMMER", "favourite colour"])
  })

  test("an escaped fallback in sanitized HTML is not double-escaped", () => {
    expect(html("{{first_name|Tom &amp; Jerry}}", {}).out).toBe(
      "Tom &amp; Jerry",
    )
  })

  test("sanitizer-escaped quotes and comparisons inside tags still parse", () => {
    expect(
      html(
        "{% if n &gt; 1 %}many{% else %}one{% endif %} {{ x | default: &quot;y&quot; }}",
        { n: "5" },
      ).out,
    ).toBe("many y")
  })
})

describe("escaping and one-pass rendering", () => {
  test("a contact value is escaped and never re-parsed", () => {
    const vars = {
      first_name: "<script>alert(1)</script>{{secret}}{% if 1 %}x{% endif %}",
      secret: "LEAK",
    }
    const { out } = html("Hi {{first_name}}", vars)
    expect(out).not.toContain("<script>")
    expect(out).not.toContain("LEAK")
    expect(out).toContain("{{secret}}")
  })

  test("the raw filter and raw tag cannot bypass escaping", () => {
    expect(html("{{ x | raw }}", { x: "<b>" }).out).toBe("&lt;b&gt;")
    expect(() => html("{% raw %}<b>{% endraw %}", {})).toThrow(TemplateError)
  })

  test("a string literal is escaped like a value", () => {
    expect(html('{{ "<i>" }}', {}).out).toBe("&lt;i&gt;")
  })
})

describe("URLs", () => {
  test("javascript: is refused, http(s) kept, inner tokens encoded", () => {
    const missing = new Set<string>()
    expect(mergeUrl("{{u}}", { u: "javascript:alert(1)" }, missing)).toBe("")
    expect(mergeUrl("{{u}}", { u: "https://a.test/x" }, missing)).toBe(
      "https://a.test/x",
    )
    expect(mergeUrl("https://a.test/?q={{q}}", { q: "a b&c=d" }, missing)).toBe(
      "https://a.test/?q=a%20b%26c%3Dd",
    )
    expect(mergeUrl('{{ u | default: "https://f.test" }}', {}, missing)).toBe(
      "https://f.test",
    )
  })

  test("a {% tag %} in a URL refuses the URL", () => {
    expect(
      mergeUrl("https://a.test/{% if x %}y{% endif %}", { x: "1" }, new Set()),
    ).toBe("")
  })

  test("an href in HTML is merged as a URL; a value cannot forge a parked slot", () => {
    const out = mergeHtml(
      '<a href="{{u}}">{{label}}</a>',
      { u: "javascript:x", label: "\u0000anything:0\u0000" },
      new Set(),
    )
    expect(out).toBe('<a href="">\u0000anything:0\u0000</a>')
  })
})

describe("refused tags and limits", () => {
  test.each([
    '{% include "x" %}',
    '{% render "x" %}',
    '{% layout "x" %}',
    "{% block a %}{% endblock %}",
    "{% tablerow i in (1..2) %}{% endtablerow %}",
    "{% liquid echo 1 %}",
  ])("%s is refused as a parse error", (template) => {
    expect(templateError(template)).toBeDefined()
    try {
      html(template, {})
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(TemplateError)
      expect((error as TemplateError).reason).toBe("parse")
    }
  })

  test("an unclosed tag is a typed parse error", () => {
    expect(() => html("{% if a %}x", {})).toThrow(TemplateError)
    expect(templateError("{% if a %}x")).toMatch(NOT_CLOSED)
  })

  test(`nesting ${TEMPLATE_MAX_DEPTH} renders, ${TEMPLATE_MAX_DEPTH + 1} is refused`, () => {
    const nest = (n: number) =>
      `${"{% if a %}".repeat(n)}x${"{% endif %}".repeat(n)}`
    expect(html(nest(TEMPLATE_MAX_DEPTH), { a: "1" }).out).toBe("x")
    try {
      html(nest(TEMPLATE_MAX_DEPTH + 1), { a: "1" })
      expect.unreachable()
    } catch (error) {
      expect((error as TemplateError).reason).toBe("depth")
    }
    // Deep enough to overflow the recursive parser: the cap fires first.
    expect(templateError(nest(3000))).toMatch(NESTS_TOO_DEEP)
  })

  test("a template at the size cap renders; one over is refused", () => {
    const pad = "a".repeat(TEMPLATE_MAX_BYTES - "{{x}}".length)
    expect(html(`${pad}{{x}}`, { x: "" }).out).toBe(pad)
    try {
      html(`${pad}{{x}}b`, {})
      expect.unreachable()
    } catch (error) {
      expect((error as TemplateError).reason).toBe("size")
    }
  })

  test("a runaway loop hits a render limit, typed", () => {
    try {
      html(
        "{% for a in (1..100000) %}{% for b in (1..100000) %}{% endfor %}{% endfor %}",
        {},
      )
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(TemplateError)
      expect((error as TemplateError).reason).toBe("render")
    }
  })
})

describe("unhappy inputs", () => {
  test("non-string template and non-object vars are rejected", () => {
    expect(() => renderTemplate(null as never, {}, new Set(), "html")).toThrow(
      TypeError,
    )
    expect(() =>
      renderTemplate("{{x}}", null as never, new Set(), "html"),
    ).toThrow(TypeError)
  })

  test("text with no delimiters is returned untouched", () => {
    expect(html("plain & <b>", {}).out).toBe("plain & <b>")
  })

  test("fuzz: brace and tag soup never throws anything but TemplateError", () => {
    const parts = [
      "{{",
      "}}",
      "{%",
      "%}",
      "if",
      "endif",
      "for",
      "|",
      "a",
      " ",
      '"',
      "'",
      "else",
      "x in (1..3)",
      "-",
      "&quot;",
      "\n",
    ]
    let seed = 42
    const rand = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31
      return seed / 2 ** 31
    }
    for (let i = 0; i < 2000; i++) {
      let template = ""
      const len = Math.floor(rand() * 20)
      for (let j = 0; j < len; j++) {
        template += parts[Math.floor(rand() * parts.length)]
      }
      for (const mode of ["html", "text", "url"] as const) {
        try {
          renderTemplate(template, { a: "1" }, new Set(), mode)
        } catch (error) {
          expect(error, template).toBeInstanceOf(TemplateError)
        }
      }
      expect(() => tokenNames(template)).not.toThrow()
    }
  })
})

describe("documents", () => {
  const doc = (text: string, preheader?: string): EmailDocument =>
    ({
      version: 1,
      settings: preheader ? { preheader } : {},
      blocks: [{ id: "1", type: "text", text }],
    }) as EmailDocument

  test("collectRenderInputs lists Liquid names and flags an invalid template", () => {
    const inputs = collectRenderInputs(doc(`<p>${OWNER}</p>`))
    expect(inputs.tokenNames).toEqual(["company", "first_name"])
    expect(inputs.invalid).toBeUndefined()
    expect(collectRenderInputs(doc("<p>{% if a %}</p>")).invalid).toMatch(
      NOT_CLOSED,
    )
    expect(
      collectRenderInputs(doc("<p>x</p>", "{% include 'a' %}")).invalid,
    ).toBeDefined()
  })

  test("the owner example renders its else branch in body and preheader", async () => {
    const out = await renderEmail(doc(`<p>${OWNER}</p>`, OWNER), {
      vars: { company: "Acme" },
    })
    expect(out.html).toContain("Hi Acme Team,")
    expect(out.text).toContain("Hi Acme Team,")
    expect(out.missing).toEqual(["first_name"])
  })

  test("a link is not tracked when its URL holds a tag", async () => {
    const tracked: string[] = []
    await renderEmail(
      doc('<p><a href="https://a.test/{% if x %}y{% endif %}">l</a></p>'),
      {
        vars: {},
        link: (url) => {
          tracked.push(url)
          return url
        },
      },
    )
    expect(tracked).toEqual([])
  })
})
