import {
  collectRenderInputs,
  type EmailDocument,
  mergePlain,
  TemplateError,
  templateError,
} from "@chatbotx.io/email-document"

/**
 * Sample values for the editor preview's system-field tokens, so
 * `Hello {{first_name}}` previews as "Hello Alex" instead of "Hello ". Only
 * the contact system fields get a sample: a custom field, a bot field or a
 * coupon stays unresolved, and the preview keeps listing it as missing (its
 * fallback, if any, is what a contact without the value would get).
 */
export const PREVIEW_SAMPLE_VALUES: Readonly<Record<string, string>> = {
  first_name: "Alex",
  last_name: "Rivera",
  full_name: "Alex Rivera",
  email: "alex@example.com",
  phone: "+1 555 010 0199",
  user_country: "United States",
  user_state: "Colorado",
  user_city: "Denver",
}

/** The sample map for the tokens `doc` uses; `{}` for a draft it cannot read. */
export function previewSampleVars(doc: EmailDocument): Record<string, string> {
  let names: string[]
  try {
    names = collectRenderInputs(doc).tokenNames
  } catch {
    return {}
  }
  const vars: Record<string, string> = {}
  for (const name of names) {
    const sample = Object.hasOwn(PREVIEW_SAMPLE_VALUES, name)
      ? PREVIEW_SAMPLE_VALUES[name]
      : undefined
    if (sample !== undefined) {
      vars[name] = sample
    }
  }
  return vars
}

export type HeaderPreview =
  | { ok: true; sample: string; empty: string }
  | { ok: false; error: string }

/**
 * A subject/preheader as a send renders it (s227b: the same Liquid
 * evaluator, plain-text mode), twice: with the sample contact, and with no
 * contact fields at all - the `{% else %}` / fallback a bare contact gets.
 */
export function headerPreview(text: string): HeaderPreview | undefined {
  if (!(text.includes("{{") || text.includes("{%"))) {
    return
  }
  const invalid = templateError(text, "text")
  if (invalid) {
    return { ok: false, error: invalid }
  }
  try {
    return {
      ok: true,
      sample: mergePlain(text, PREVIEW_SAMPLE_VALUES, new Set()),
      empty: mergePlain(text, {}, new Set()),
    }
  } catch (error) {
    if (error instanceof TemplateError) {
      return { ok: false, error: error.message }
    }
    throw error
  }
}
