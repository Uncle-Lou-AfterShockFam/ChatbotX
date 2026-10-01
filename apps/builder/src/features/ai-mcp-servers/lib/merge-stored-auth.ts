import {
  type AIMcpServerAuth,
  aiMcpServerAuth,
} from "@chatbotx.io/database/partials"
import type { PrivateAIMcpServerAuthKeepingSecrets } from "../schema/action"

export type MergeStoredAuthResult =
  | { status: "ok"; auth: AIMcpServerAuth }
  | { status: "missing"; path: "token" | `headers.${number}.value` }

/** True if the client left a token or header value empty (= keep stored). */
export const keepsStoredSecret = (
  auth: PrivateAIMcpServerAuthKeepingSecrets,
): boolean =>
  (auth.type === "token" && auth.token === "") ||
  (auth.type === "header" && auth.headers.some(({ value }) => value === ""))

/**
 * Fills each empty token / header value from the stored row (s232a). The
 * client never receives the stored secret, so "" means "keep it". A blank
 * with nothing stored to keep (other auth type, unknown header name, no
 * stored row) is `missing`, never an empty secret.
 */
export const mergeStoredAuth = (
  input: PrivateAIMcpServerAuthKeepingSecrets,
  stored: unknown,
): MergeStoredAuthResult => {
  const parsedStored = aiMcpServerAuth.safeParse(stored)
  const storedAuth = parsedStored.success ? parsedStored.data : null

  if (input.type === "none") {
    return { status: "ok", auth: { type: "none" } }
  }

  if (input.type === "token") {
    if (input.token !== "") {
      return { status: "ok", auth: { type: "token", token: input.token } }
    }
    return storedAuth?.type === "token"
      ? { status: "ok", auth: { type: "token", token: storedAuth.token } }
      : { status: "missing", path: "token" }
  }

  const storedHeaders = storedAuth?.type === "header" ? storedAuth.headers : []
  const headers: { header: string; value: string }[] = []
  for (const [index, { header, value }] of input.headers.entries()) {
    if (value !== "") {
      headers.push({ header, value })
      continue
    }
    const kept = storedHeaders.find((stored) => stored.header === header)
    if (!kept) {
      return { status: "missing", path: `headers.${index}.value` }
    }
    headers.push({ header, value: kept.value })
  }
  return { status: "ok", auth: { type: "header", headers } }
}
