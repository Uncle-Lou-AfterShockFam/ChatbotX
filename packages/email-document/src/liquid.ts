import { Liquid, LiquidError, Tag, type Template, toValue } from "liquidjs"

/**
 * THE email merge evaluator (s227b, outreach B-1 H3): Liquid, as ManyReach
 * does it - `{% if first_name %}{{first_name}}{% else %}there{% endif %}`,
 * `{{ first_name | default: "there" }}`. Preview and send both come through
 * here; there is no second renderer.
 *
 * Safety:
 * - Only control-flow and variable tags exist. include/render/layout (which
 *   read the FILESYSTEM by default), block, raw, tablerow and liquid are
 *   refused at parse time; so are echo and cycle (they write WITHOUT the
 *   output escape) and capture (its escaped text would be escaped again).
 *   The `raw` filter (it bypasses output escaping) is removed.
 * - A template is capped at 100 KB, 1000 delimiters and 16 nested blocks
 *   (checked BEFORE the recursive parser runs, in linear scans), and a
 *   render at 200 ms and 10 M allocated chars.
 * - Values are rendered once: a contact value is data, never re-parsed.
 * - A var with an empty value is left out of scope, so `{% if x %}` is false
 *   for "" (Liquid's own rule makes "" truthy).
 *
 * Legacy tokens keep rendering: `{{name|fallback}}` (the old grammar) and
 * names Liquid cannot spell (`coupon:SUMMER`, `bot_field:12`, `raw:x`, names
 * with spaces) are resolved in JS with the old semantics and handed to Liquid
 * as precomputed values.
 */

export type TokenVars = Readonly<Record<string, string>>

/** Escape: HTML bodies. Text: subject/preheader. Url: a token inside a URL. */
export type TemplateMode = "html" | "text" | "url"

export const TEMPLATE_MAX_BYTES = 100_000
export const TEMPLATE_MAX_DEPTH = 16
/** `{{ }}` + `{% %}` per template; also bounds the name analysis (O(n^2)). */
export const TEMPLATE_MAX_DELIMITERS = 1000
const RENDER_LIMIT_MS = 200
const MEMORY_LIMIT = 10_000_000

export type TemplateErrorReason = "parse" | "render" | "size" | "depth"

/** Any template the evaluator refuses or cannot render. */
export class TemplateError extends Error {
  readonly reason: TemplateErrorReason
  constructor(reason: TemplateErrorReason, message: string) {
    super(message)
    this.name = "TemplateError"
    this.reason = reason
  }
}

const REFUSED_TAGS = [
  "include",
  "render",
  "layout",
  "block",
  "raw",
  "tablerow",
  "liquid",
  "echo",
  "cycle",
  "capture",
] as const

class RefusedTag extends Tag {
  constructor(...args: ConstructorParameters<typeof Tag>) {
    super(...args)
    throw new Error(`the {% ${args[0].name} %} tag is not allowed`)
  }
  *render(): Generator<unknown, void, unknown> {
    // Unreachable: the constructor refuses the tag at parse time.
  }
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function createEngine(outputEscape?: (value: unknown) => string): Liquid {
  const engine = new Liquid({
    outputEscape,
    strictFilters: false,
    strictVariables: false,
    ownPropertyOnly: true,
    // Legacy slots lengthen the source (<= ~25 chars per delimiter).
    parseLimit: TEMPLATE_MAX_BYTES * 2,
    renderLimit: RENDER_LIMIT_MS,
    memoryLimit: MEMORY_LIMIT,
    // Never a filesystem root: every file tag is refused anyway.
    root: [],
    partials: [],
    layouts: [],
    relativeReference: false,
  })
  for (const name of REFUSED_TAGS) {
    engine.registerTag(name, RefusedTag)
  }
  // biome-ignore lint/performance/noDelete: the filter must not exist at all (an own `raw: undefined` would still read as a filter name)
  delete (engine.filters as Record<string, unknown>).raw
  return engine
}

/** Liquid's own output stringification, the SAME for every mode. */
function stringify(value: unknown): string {
  const plain = toValue(value)
  if (plain === null || plain === undefined) {
    return ""
  }
  if (Array.isArray(plain)) {
    return plain.map(stringify).join("")
  }
  return typeof plain === "object" ? "" : String(plain)
}

const ENGINES: Record<TemplateMode, Liquid> = {
  html: createEngine((value) => escapeHtml(stringify(value))),
  text: createEngine(stringify),
  url: createEngine((value) => encodeURIComponent(stringify(value))),
}

const OUTPUT = /\{\{(-?)([^{}]*?)(-?)\}\}/g
/**
 * A Liquid output head: one flat name (vars are flat strings, so a dotted
 * `{{x.y}}` stays the legacy name "x.y" - custom field names are free
 * text), a bracketed name, or a literal.
 */
const LIQUID_HEAD =
  /^\s*(?:[A-Za-z_][\w-]*|\[(?:"[^"]*"|'[^']*')\]|"[^"]*"|'[^']*'|-?\d+(?:\.\d+)?)\s*$/
const TRAILING_SPACE = /\s$/
/** Bare Liquid literals: a var with such a name still resolves as a var. */
const LIQUID_KEYWORDS = new Set([
  "nil",
  "null",
  "empty",
  "blank",
  "true",
  "false",
])
const FILTER_HEAD = /^(\s*)([A-Za-z_][\w-]*)\s*(:|\||$)/
const BLOCK_TAG = /\{%-?\s*(end)?(if|unless|for|case|capture|comment)\b/g
const LEGACY_SCOPE_KEY = "__bt_legacy"

export function unescapeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
}

type Legacy = { name: string; fallback: string | undefined }

/**
 * An output whose head is not a Liquid expression is a legacy token. So is
 * `{{name|word}}` unless `word` is a filter written the Liquid way: with an
 * argument (`| default: "x"`), chained (`| upcase | strip`) or with spacing
 * around the pipe (`{{ name | upcase }}`). The compact `{{name|upcase}}`
 * keeps its old meaning - the fallback text "upcase".
 */
function legacyToken(content: string, engine: Liquid): Legacy | undefined {
  const pipe = content.indexOf("|")
  const head = pipe < 0 ? content : content.slice(0, pipe)
  const tail = pipe < 0 ? undefined : content.slice(pipe + 1)
  const filter = tail === undefined ? undefined : FILTER_HEAD.exec(tail)
  const liquidFilter =
    filter !== undefined &&
    filter !== null &&
    Object.hasOwn(engine.filters, filter[2] as string) &&
    (filter[3] !== "" || filter[1] !== "" || TRAILING_SPACE.test(head))
  const liquid =
    LIQUID_HEAD.test(head) &&
    !LIQUID_KEYWORDS.has(head.trim()) &&
    (tail === undefined || liquidFilter)
  if (liquid || head.trim() === "" || head.includes("\n")) {
    return
  }
  return { name: head.trim(), fallback: tail }
}

type Prepared = { source: string; legacy: Legacy[] }

/**
 * html mode: entities inside `{{ }}` / `{% %}` are unescaped first (the
 * sanitizer escapes quotes and `<`/`>` in rich text), so `"x"` is a Liquid
 * string and `>` a comparison. Then legacy outputs become precomputed slots.
 */
function prepare(template: string, mode: TemplateMode): Prepared {
  if (template.length > TEMPLATE_MAX_BYTES) {
    throw new TemplateError(
      "size",
      `template is ${template.length} characters (limit ${TEMPLATE_MAX_BYTES})`,
    )
  }
  assertDepth(template)
  const engine = ENGINES[mode]
  const unescaped = scanDelimited(template, mode === "html")
  const legacy: Legacy[] = []
  const source = unescaped.replace(
    OUTPUT,
    (match, left: string, content: string, right: string) => {
      const token = legacyToken(content, engine)
      if (!token) {
        return match
      }
      legacy.push(token)
      return `{{${left} ${LEGACY_SCOPE_KEY}[${legacy.length - 1}] ${right}}}`
    },
  )
  return { source, legacy }
}

/**
 * One linear pass over the delimiters: counts them against the cap and, in
 * html mode, unescapes entities inside each. An unclosed opener ends the
 * scan (no later opener can close either; the parser reports it).
 */
function scanDelimited(template: string, unescapeInside: boolean): string {
  let out = ""
  let from = 0
  let count = 0
  while (from < template.length) {
    const open = template.indexOf("{", from)
    if (open < 0 || open + 1 >= template.length) {
      break
    }
    const kind = template[open + 1]
    if (kind !== "{" && kind !== "%") {
      out += template.slice(from, open + 1)
      from = open + 1
      continue
    }
    const close = template.indexOf(kind === "{" ? "}}" : "%}", open + 2)
    if (close < 0) {
      break
    }
    count += 1
    if (count > TEMPLATE_MAX_DELIMITERS) {
      throw new TemplateError(
        "size",
        `template has more than ${TEMPLATE_MAX_DELIMITERS} merge fields and tags`,
      )
    }
    const segment = template.slice(open, close + 2)
    out +=
      template.slice(from, open) +
      (unescapeInside ? unescapeEntities(segment) : segment)
    from = close + 2
  }
  return out + template.slice(from)
}

/** Nesting cap BEFORE parsing: the parser itself recurses per block. */
function assertDepth(template: string): void {
  let depth = 0
  for (const match of template.matchAll(BLOCK_TAG)) {
    depth += match[1] ? -1 : 1
    if (depth > TEMPLATE_MAX_DEPTH) {
      throw new TemplateError(
        "depth",
        `template nests more than ${TEMPLATE_MAX_DEPTH} blocks`,
      )
    }
  }
}

function parse(prepared: Prepared, mode: TemplateMode): Template[] {
  try {
    return ENGINES[mode].parse(prepared.source)
  } catch (err) {
    throw toTemplateError(err, "parse")
  }
}

function toTemplateError(
  err: unknown,
  reason: TemplateErrorReason,
): TemplateError {
  if (err instanceof TemplateError) {
    return err
  }
  const message = err instanceof Error ? err.message.split("\n")[0] : "error"
  return new TemplateError(
    err instanceof LiquidError && err.name === "ParseError" ? "parse" : reason,
    message ?? "error",
  )
}

/** Whether `text` holds a merge field or tag at all (else it is literal). */
export function hasTemplate(text: string): boolean {
  return text.includes("{{") || text.includes("{%")
}

function present(vars: TokenVars, name: string): string | undefined {
  const value = Object.hasOwn(vars, name) ? vars[name] : undefined
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/** Global names a template reads (first path segment), legacy names included. */
function namesOf(
  prepared: Prepared,
  templates: Template[],
  mode: TemplateMode,
) {
  const names = new Set<string>()
  for (const token of prepared.legacy) {
    names.add(token.name)
  }
  for (const segments of ENGINES[mode].globalVariableSegmentsSync(templates)) {
    const head = segments[0]
    if (typeof head === "string" && head !== LEGACY_SCOPE_KEY) {
      names.add(head)
    }
  }
  return names
}

/**
 * Render one template. Every name the template reads that has no non-empty
 * value is added to `missing` - a STATIC list (a name in an untaken branch
 * counts), which is what the editor warns on.
 */
export function renderTemplate(
  template: string,
  vars: TokenVars,
  missing: Set<string>,
  mode: TemplateMode,
): string {
  if (typeof template !== "string") {
    throw new TypeError("template must be a string")
  }
  if (vars === null || typeof vars !== "object") {
    throw new TypeError("vars must be an object")
  }
  if (!hasTemplate(template)) {
    return template
  }
  const prepared = prepare(template, mode)
  const templates = parse(prepared, mode)
  const scope: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(vars)) {
    if (typeof value === "string" && value.length > 0) {
      scope[name] = value
    }
  }
  scope[LEGACY_SCOPE_KEY] = prepared.legacy.map(({ name, fallback }) => {
    const value = present(vars, name)
    if (value !== undefined) {
      return value
    }
    return fallback?.trim() ?? ""
  })
  for (const name of namesOf(prepared, templates, mode)) {
    if (present(vars, name) === undefined) {
      missing.add(name)
    }
  }
  try {
    return ENGINES[mode].renderSync(templates, scope) as string
  } catch (err) {
    throw toTemplateError(err, "render")
  }
}

/**
 * Every name a template reads, for a caller that resolves vars first. Never
 * throws: a template that does not parse yields its legacy names only (the
 * render then fails with the typed error).
 */
export function templateNames(template: string): string[] {
  if (!hasTemplate(template)) {
    return []
  }
  let prepared: Prepared
  try {
    prepared = prepare(template, "html")
  } catch {
    return []
  }
  try {
    return [...namesOf(prepared, parse(prepared, "html"), "html")]
  } catch {
    return prepared.legacy.map((token) => token.name)
  }
}

/**
 * Why `template` cannot render (size, depth or parse), or undefined. The
 * send path checks this BEFORE it records anything, so a broken template
 * fails closed as content, never mid-send.
 */
export function templateError(
  template: string,
  mode: TemplateMode = "html",
): string | undefined {
  if (!hasTemplate(template)) {
    return
  }
  try {
    parse(prepare(template, mode), mode)
  } catch (err) {
    return toTemplateError(err, "parse").message
  }
}
