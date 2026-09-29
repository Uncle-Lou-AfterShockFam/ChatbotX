const LEADING_SLASHES_RE = /^\/+/
// A backslash, an encoded dot/separator or a control char: S3 or a proxy may
// decode or normalize these into a different key than the prefix check saw.
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them
const UNSAFE_KEY_CHARS = /[\\\u0000-\u001f\u007f]|%(2e|2f|5c)/i

/**
 * Join a stored object key onto a public storage base URL.
 *
 * `new URL(path, base)` is deceptively fragile here: a leading slash on `path`,
 * or a missing trailing slash on `base`, silently drops the base's own path
 * segment — e.g. the bucket in `https://cdn.example.com/chatbotx/`. Normalizing
 * both sides keeps the base (bucket prefix included) intact.
 *
 * An already-absolute `path` (http/https) is returned unchanged.
 */
export const getPublicFileUrl = (path: string, baseUrl: string): string => {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`
  return new URL(path.replace(LEADING_SLASHES_RE, ""), base).toString()
}

/**
 * True when `path` is a plain object key under ONE workspace's own storage
 * prefix (`workspaces/<id>/` or `public/space/<id>/`). A prefix test alone is
 * not enough: `workspaces/A/../B/x` starts with A's prefix but names B's
 * object, so every segment must be a real name (no `.`, `..` or empty).
 */
export const isWorkspaceStorageKey = (
  path: string,
  workspaceId: string,
): boolean => {
  if (typeof path !== "string" || workspaceId === "") {
    return false
  }
  if (UNSAFE_KEY_CHARS.test(path)) {
    return false
  }
  if (
    path
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return false
  }
  return (
    path.startsWith(`workspaces/${workspaceId}/`) ||
    path.startsWith(`public/space/${workspaceId}/`)
  )
}
