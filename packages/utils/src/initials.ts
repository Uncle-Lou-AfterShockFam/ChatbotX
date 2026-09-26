const segmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null

/**
 * The first `count` user-perceived characters of `name` for an avatar
 * fallback. `name.slice(0, 2)` counts UTF-16 units, so a name whose second
 * character is an emoji ("J😀hn") yields a lone surrogate: the server's UTF-8
 * HTML carries U+FFFD while the client renders the surrogate, a React #418
 * text mismatch (s209). Grapheme segmentation also keeps ZWJ families, flags
 * and combining marks whole; code points are the fallback where
 * `Intl.Segmenter` is missing.
 */
export function nameInitials(
  name: string | null | undefined,
  count = 2,
): string {
  if (typeof name !== "string" || name === "" || count <= 0) {
    return ""
  }
  if (segmenter) {
    let out = ""
    let taken = 0
    for (const { segment } of segmenter.segment(name)) {
      if (taken === count) {
        break
      }
      out += segment
      taken += 1
    }
    return out
  }
  return Array.from(name).slice(0, count).join("")
}
