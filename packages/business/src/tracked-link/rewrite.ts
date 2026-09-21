import { buildTrackedLinkUrl, MAX_TRACKED_LINK_URL_LENGTH } from "./url"

/**
 * Every http(s) URL in a text. Trailing sentence punctuation is not part of
 * a URL a person typed ("see https://x.y/z." ends at "z"), so it is peeled
 * off after the match.
 */
const HTTP_URL_PATTERN = /https?:\/\/[^\s<>"'\])]+/g
const TRAILING_PUNCTUATION = /[.,;:!?]+$/

export type TrackedLinkMinter = (url: string) => Promise<string>

export type RewriteTrackedLinksOptions = {
  /**
   * URLs shorter than this stay verbatim. `0` (the default) rewrites every
   * URL, which is what click TRACKING wants; a SHORTENER passes a threshold
   * so a short branded link an author typed is not replaced by a longer
   * opaque one.
   */
  minLength?: number
}

/**
 * Whether one URL gets a tracked/short form. A URL already under
 * `${appUrl}/go/` is left alone so a re-sent text is not double-wrapped, and
 * one the mint would refuse (over the stored-URL bound) is left alone rather
 * than failing the send.
 */
export const shouldRewriteUrl = (
  url: string,
  appUrl: string,
  options: RewriteTrackedLinksOptions = {},
): boolean => {
  const minLength = options.minLength ?? 0
  return (
    url.length >= minLength &&
    url.length <= MAX_TRACKED_LINK_URL_LENGTH &&
    !url.startsWith(buildTrackedLinkUrl(appUrl, ""))
  )
}

/**
 * Pure rewrite: replaces every qualifying URL in `text` with the short URL
 * the minter returns for it. One token per occurrence, in order.
 */
export async function rewriteTrackedLinks(
  text: string,
  appUrl: string,
  mint: TrackedLinkMinter,
  options: RewriteTrackedLinksOptions = {},
): Promise<{ text: string; minted: number }> {
  let minted = 0
  let out = ""
  let last = 0
  for (const match of text.matchAll(HTTP_URL_PATTERN)) {
    const raw = match[0]
    const trailing = raw.match(TRAILING_PUNCTUATION)?.[0] ?? ""
    const url = trailing === "" ? raw : raw.slice(0, -trailing.length)
    const start = match.index ?? 0
    out += text.slice(last, start)
    if (shouldRewriteUrl(url, appUrl, options)) {
      out += buildTrackedLinkUrl(appUrl, await mint(url)) + trailing
      minted += 1
    } else {
      out += raw
    }
    last = start + raw.length
  }
  out += text.slice(last)
  return { text: out, minted }
}
