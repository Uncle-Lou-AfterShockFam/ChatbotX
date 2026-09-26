/**
 * The first `count` code points of `name` for an avatar fallback.
 * `name.slice(0, 2)` counts UTF-16 units, so a name whose second character is
 * an emoji ("J😀hn") yields a lone surrogate: the server's UTF-8 HTML carries
 * U+FFFD while the client renders the surrogate, a React #418 text mismatch
 * (s209). Code points, not graphemes: `Intl.Segmenter` boundaries come from
 * each engine's ICU tables, so Node and an older browser could cut a new emoji
 * sequence differently and mismatch again; code points are identical
 * everywhere (a ZWJ sequence may show its first person only).
 */
export function nameInitials(
  name: string | null | undefined,
  count = 2,
): string {
  if (typeof name !== "string" || count <= 0) {
    return ""
  }
  return Array.from(name).slice(0, count).join("")
}
