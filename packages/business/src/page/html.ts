import type { EmailDocument } from "@chatbotx.io/email-document"
import { escapeHtml } from "@chatbotx.io/email-document"

/**
 * A rendered page body (`renderWeb` output, already sanitized) as a whole
 * HTML document: phone-width viewport, 16 px side gutter, the document's
 * background behind the column. Nothing here takes user HTML unescaped
 * except `body`, which only renderWeb produces.
 */
export function pageHtml(props: {
  title: string
  document: EmailDocument
  body: string
}): string {
  const background = props.document.settings.background ?? "#ffffff"
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>${escapeHtml(props.title)}</title><style>body{margin:0;padding:24px 16px;background:${background};color:#111;line-height:1.5}img{max-width:100%;height:auto}figure{margin:0 0 16px}</style></head><body>${props.body}</body></html>`
}

/** The generic refusal page: never names the page or the contact. */
export function pageMessageHtml(props: { title: string; body: string }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>${escapeHtml(props.title)}</title><style>body{font-family:system-ui,-apple-system,Helvetica,Arial,sans-serif;margin:0;padding:48px 16px;background:#f6f7f9;color:#111}main{max-width:420px;margin:0 auto;background:#fff;border-radius:12px;padding:28px 24px;box-shadow:0 1px 3px rgba(0,0,0,.08)}h1{font-size:18px;margin:0 0 12px}p{margin:0;line-height:1.5;color:#444}</style></head><body><main><h1>${escapeHtml(props.title)}</h1><p>${escapeHtml(props.body)}</p></main></body></html>`
}
