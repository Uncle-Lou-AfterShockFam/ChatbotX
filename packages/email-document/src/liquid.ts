import { Liquid, LiquidError, Tag, type Template } from "liquidjs"

/**
 * THE email merge evaluator (s227b, outreach B-1 H3): Liquid, as ManyReach
 * does it - `{% if first_name %}{{first_name}}{% else %}there{% endif %}`,
 * `{{ first_name | default: "there" }}`. Preview and send both come through
 * here; there is no second renderer.
 *
 * Safety:
 * - Only control-flow and variable tags exist. include/render/layout (which
 *   read the FILESYSTEM by default), block, raw, tablerow and liquid are
 *   refused at parse time, and the `raw` filter (it bypasses output
 *   escaping) is removed.
 * - A template is capped at 100 KB and 16 nested blocks (checked BEFORE the
 *   recursive parser runs), and a render at 200 ms and 10 M allocated chars.
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
    parseLimit: TEMPLATE_MAX_BYTES,
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

const ENGINES: Record<TemplateMode, Liquid> = {
  html: createEngine((value) => escapeHtml(String(value ?? ""))),
  text: createEngine(),
  url: createEngine((value) => encodeURIComponent(String(value ?? ""))),
}

const OUTPUT = /\{\{(-?)([^{}]*?)(-?)\}\}/g
const DELIMITED = /\{\{[^{}]*\}\}|\{%[\s\S]*?%\}/g
const LIQUID_HEAD = new RegExp(
  String.raw`^\s*(?:` +
    String.raw`(?:[A-Za-z_][\w-]*|\[(?:"[^"]*"|'[^']*')\])` +
    String.raw`(?:\.[A-Za-z_][\w-]*|\[(?:"[^"]*"|'[^']*'|\d+|[A-Za-z_][\w.-]*)\])*` +
    String.raw`|"[^"]*"|'[^']*'|-?\d+(?:\.\d+)?|\(\s*-?\w+\s*\.\.\s*-?\w+\s*\))\s*$`,
)
const FILTER_HEAD = /^\s*([A-Za-z_][\w-]*)\s*(?::|\||$)/
const BLOCK_TAG = /\{%-?\s*(end)?(if|unless|for|case|capture|comment)\b/g
const LEGACY_SCOPE_KEY = "__bt_legacy"

function unescapeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
}

type Legacy = { name: string; fallback: string | undefined }

/**
 * An output whose head is not a Liquid expression, or whose `|` is followed
 * by something that is not a filter, is a legacy `{{name|fallback}}` token.
 */
function legacyToken(content: string, engine: Liquid): Legacy | undefined {
  const pipe = content.indexOf("|")
  const head = pipe < 0 ? content : content.slice(0, pipe)
  const tail = pipe < 0 ? undefined : content.slice(pipe + 1)
  const filter = tail === undefined ? undefined : FILTER_HEAD.exec(tail)?.[1]
  const liquid =
    LIQUID_HEAD.test(head) &&
    (tail === undefined ||
      (filter !== undefined && Object.hasOwn(engine.filters, filter)))
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
  const unescaped =
    mode === "html"
      ? template.replace(DELIMITED, (match) => unescapeEntities(match))
      : template
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
  if (!(template.includes("{{") || template.includes("{%"))) {
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
  if (!(template.includes("{{") || template.includes("{%"))) {
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
  if (!(template.includes("{{") || template.includes("{%"))) {
    return
  }
  try {
    parse(prepare(template, mode), mode)
  } catch (err) {
    return toTemplateError(err, "parse").message
  }
}
