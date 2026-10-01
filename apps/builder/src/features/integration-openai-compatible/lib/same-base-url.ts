const TRAILING_SLASHES = /\/+$/

const normalise = (url: string) =>
  new URL(url).href.replace(TRAILING_SLASHES, "")

/** Same origin + path after URL normalisation; unparsable never matches. */
export const isSameBaseUrl = (
  a: string | undefined,
  b: string | undefined,
): boolean => {
  if (!(a && b)) {
    return false
  }
  try {
    return normalise(a) === normalise(b)
  } catch {
    return false
  }
}
